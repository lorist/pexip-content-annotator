/**
 * Capture the current presentation/content frame as a PNG data URL by reading
 * the webapp's presentation <video> element from the parent document.
 *
 * Why the DOM (and not the Client API): in production the plugin iframe is
 * same-origin with the webapp (`allow-same-origin`), so `window.parent.document`
 * is reachable; and the presentation video is MediaStream-backed, so a canvas
 * export is NOT CORS-tainted. The Client API `presentation*.jpeg` endpoints are
 * unusable from the sandbox — they require the SSE `presentation_frame` id
 * (which @pexip/plugin-api never exposes), and `sendRequest` can neither carry a
 * typed `id` argument nor return binary. (See git history / README for the full
 * investigation.)
 *
 * Throws with a diagnostic (the list of parent <video> elements) when no
 * presentation video can be captured, so the editor/toast can show why.
 */
export async function captureContentFrame(): Promise<string> {
  const notes: string[] = [];
  const dataUrl = captureFromParentDom(notes);
  if (dataUrl) {
    console.log('[content-annotator] captured via parent DOM <video>');
    return dataUrl;
  }
  throw new Error(notes.join('  |  ') || 'no presentation video found');
}

/**
 * Read the presentation <video> from the parent (webapp) document and export it
 * via canvas. Same-origin only (production). Pushes a description of every
 * parent <video> into `notes` so the right element can be identified if the
 * heuristic ever misses (e.g. a future webapp3 DOM change).
 */
function captureFromParentDom(notes: string[]): string | null {
  // Reach the webapp document (try parent, then top).
  let doc: Document | null = null;
  for (const w of [window.parent, window.top].filter(Boolean) as Window[]) {
    try {
      const d = w.document;
      void d.title; // forces a cross-origin SecurityError if not accessible
      doc = d;
      break;
    } catch (e) {
      notes.push(`parent not accessible (${String(e).slice(0, 60)}) — same-origin/prod only`);
    }
  }
  if (!doc) return null;

  const vids = Array.from(doc.querySelectorAll('video')) as HTMLVideoElement[];
  if (!vids.length) {
    notes.push('no <video> elements in parent');
    return null;
  }

  // Discovery: describe every candidate (shown in the diagnostic + console).
  const describe = (v: HTMLVideoElement, i: number) =>
    `#${i} ${v.videoWidth}x${v.videoHeight} testid=${v.getAttribute('data-testid') || '-'} ` +
    `class="${(v.className || '').toString().slice(0, 40)}" muted=${v.muted}`;
  const list = vids.map(describe);
  console.log('[content-annotator] parent <video> elements:', list);
  notes.push(`videos: ${list.join(' ; ')}`);

  // Prefer presentation-tagged elements, else the largest live video.
  const selectors = [
    '[data-testid="video-presentation"]',
    '[data-testid*="presentation" i]',
    '[data-testid*="screen" i]',
    '[data-testid*="content" i]',
    'video[class*="presentation" i]',
    '[class*="presentation" i] video',
  ];
  let chosen: HTMLVideoElement | undefined;
  for (const sel of selectors) {
    const hit = doc.querySelector(sel);
    const v = (hit?.tagName === 'VIDEO' ? hit : hit?.querySelector('video')) as
      | HTMLVideoElement
      | null;
    if (v && v.videoWidth > 0) {
      chosen = v;
      notes.push(`matched selector ${sel}`);
      break;
    }
  }
  if (!chosen) {
    const live = vids.filter((v) => v.videoWidth > 0 && v.videoHeight > 0);
    // self-view is usually muted; prefer non-muted, then largest area
    live.sort(
      (a, b) =>
        Number(a.muted) - Number(b.muted) ||
        b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight,
    );
    chosen = live[0];
    if (chosen) notes.push('fell back to largest live <video>');
  }
  if (!chosen || !chosen.videoWidth) {
    notes.push('no <video> has frames (is content being shared?)');
    return null;
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = chosen.videoWidth;
    canvas.height = chosen.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(chosen, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch (e) {
    notes.push(`drawImage/export failed (tainted?): ${String(e).slice(0, 80)}`);
    return null;
  }
}
