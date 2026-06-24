/**
 * Best-effort presentation of a canvas stream into the meeting.
 *
 * Four strategies are tried in order:
 *
 * **Strategy A — Direct client discovery:** scan the parent window for any
 * object that exposes a `present(stream)` method (the InfinityClient).
 *
 * **Strategy B — ReplaceTrack on existing PeerConnection:** if the user is
 * already presenting, find the RTCPeerConnection (via `pexDebug` or deep scan),
 * locate the presentation sender, and replace its track with our canvas stream.
 * This is the most reliable approach when presentation is already active.
 *
 * **Strategy C — getDisplayMedia interception:** if no presentation is active,
 * temporarily replace `getDisplayMedia` in the parent window, then click the
 * webapp's "Share content" button so the webapp's normal flow takes our stream.
 *
 * **Fallback:** if nothing works, return `null` and log diagnostics.
 */

const P = '[content-annotator/present]';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSameOriginParent(): Window | null {
  for (const w of [window.parent, window.top].filter(Boolean) as Window[]) {
    try {
      void w.document.title;
      if (w !== window) return w;
    } catch { /* cross-origin */ }
  }
  return null;
}

function resolve(root: any, path: string): any {
  let cur = root;
  for (const key of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

interface PresentMethods {
  present: (stream: MediaStream) => void;
  stopPresenting: () => void;
}

function wrapClient(client: any): PresentMethods {
  return {
    present: (s: MediaStream) => client.present(s),
    stopPresenting: typeof client.stopPresenting === 'function'
      ? () => client.stopPresenting()
      : () => console.warn(P, 'stopPresenting() not available on client'),
  };
}

// ---------------------------------------------------------------------------
// Strategy A — Direct client discovery
// ---------------------------------------------------------------------------

const KNOWN_PROBES: string[] = [
  '__pexipClient',
  'pexipClient',
  'infinityClient',
  'client',
  'pexDebug.client',
  'pexDebug.infinityClient',
  'pexDebug.conference.client',
  'pexDebug.call.client',
  'pexApp.client',
  'pexApp.infinityClient',
  'app.client',
  'app.infinityClient',
  '__PEXIP__',
  '__PEXIP__.client',
  '__PEXIP__.infinityClient',
  '__STORE__.client',
  '__store__.client',
];

function deepScanForPresent(win: Window): string[] {
  const found: string[] = [];
  const seen = new WeakSet();

  const SKIP = new Set([
    'document', 'location', 'navigator', 'performance', 'screen',
    'history', 'chrome', 'clientInformation', 'speechSynthesis',
    'caches', 'cookieStore', 'scheduler', 'customElements',
    'visualViewport', 'navigation', 'external', 'styleMedia',
    'parent', 'top', 'self', 'window', 'frames', 'opener',
    'localStorage', 'sessionStorage', 'indexedDB', 'crypto',
  ]);

  function scan(obj: any, path: string, depth: number): void {
    if (depth > 4 || obj == null) return;
    const t = typeof obj;
    if (t !== 'object' && t !== 'function') return;
    if (obj instanceof Node || obj instanceof Event) return;
    try { if (seen.has(obj)) return; seen.add(obj); } catch { return; }

    let keys: string[];
    try { keys = Object.keys(obj); } catch { return; }
    if (keys.length > 500) return;

    for (const key of keys) {
      if (depth === 0 && SKIP.has(key)) continue;
      try {
        const val = obj[key];
        if (val instanceof Node || val instanceof Event) continue;
        if (typeof val === 'function' && key === 'present') {
          found.push(path);
        }
        if (val != null && (typeof val === 'object' || typeof val === 'function')) {
          scan(val, path + '.' + key, depth + 1);
        }
      } catch { /* getter threw */ }
    }
  }

  scan(win, 'window', 0);
  return found;
}

function findPresentMethods(): PresentMethods | null {
  const win = getSameOriginParent();
  if (!win) {
    console.warn(P, 'No same-origin parent window available');
    return null;
  }

  for (const probe of KNOWN_PROBES) {
    const client = resolve(win, probe);
    if (client && typeof client.present === 'function') {
      console.log(P, `Strategy A: found present() via "${probe}"`);
      return wrapClient(client);
    }
  }

  console.log(P, 'Known probes missed — running deep scan…');
  const hits = deepScanForPresent(win);
  if (hits.length > 0) {
    console.log(P, 'Deep scan found present() at:', hits);
    const path = hits[0].replace(/^window\./, '');
    const client = resolve(win, path);
    if (client && typeof client.present === 'function') {
      console.log(P, `Strategy A: using deep-scan result "${path}"`);
      return wrapClient(client);
    }
  }

  console.warn(P, 'Strategy A failed — present() not found on any parent global');
  return null;
}

// ---------------------------------------------------------------------------
// Strategy B — Stop-and-restart with getDisplayMedia interception
// ---------------------------------------------------------------------------
// When the user is already presenting, we can't access the PeerConnection
// directly (it's module-scoped in the webapp bundle). Instead:
// 1. Intercept getDisplayMedia to return our canvas stream
// 2. Click "Stop sharing" to end the current presentation
// 3. Wait for the "Share" button to appear
// 4. Click it — the webapp calls getDisplayMedia, gets our canvas stream
// 5. The webapp does take_floor + SDP renegotiation as normal

/**
 * Check whether the user is currently presenting (the "Stop sharing" button exists).
 */
function isCurrentlyPresenting(win: Window): boolean {
  return !!win.document.querySelector(
    'button[data-testid="button-stop-presentation"], button[aria-label*="Stop sharing" i]',
  );
}

/**
 * Best-effort: detect when our presentation ends in the webapp because another
 * participant took over the floor (the "Stop sharing" button disappears). Calls
 * onEnd once when that happens, then stops. Returns a cleanup function.
 *
 * Only fires AFTER presentation is first confirmed active, so the brief window
 * before the floor is taken doesn't trigger a false positive. Never fires if
 * there's no same-origin parent, or if the stop button never appears (e.g. a
 * Strategy A direct-client present with no DOM affordance).
 */
export function watchForPresentationEnd(onEnd: () => void): () => void {
  const win = getSameOriginParent();
  if (!win) return () => {};
  let confirmed = false;
  let done = false;
  const iv = setInterval(() => {
    if (done) return;
    if (isCurrentlyPresenting(win)) {
      confirmed = true;
      return;
    }
    if (confirmed) {
      done = true;
      clearInterval(iv);
      console.log(P, 'presentation ended in webapp — floor taken over by another participant');
      onEnd();
    }
  }, 1000);
  return () => { done = true; clearInterval(iv); };
}

/**
 * Click the webapp's own "Stop sharing" button so it runs the normal
 * release_floor flow and the conference cleanly stops showing the
 * presentation. Just stopping our canvas track is NOT enough — the webapp
 * keeps the floor and presents the now-dead (black) track. Returns true if a
 * stop button was found and clicked.
 */
function clickStopPresentation(win: Window): boolean {
  const stopBtn = win.document.querySelector(
    'button[data-testid="button-stop-presentation"], button[aria-label*="Stop sharing" i]',
  ) as HTMLElement | null;
  if (stopBtn) {
    console.log(P, 'clicking webapp "Stop sharing" to release the floor');
    stopBtn.click();
    return true;
  }
  console.warn(P, 'stop: no "Stop sharing" button found — presentation may not release cleanly');
  return false;
}

/** Selectors for the "Start sharing" button (not the stop button). */
const START_SHARE_SELECTORS: string[] = [
  'button[data-testid="button-start-presentation"]',
  'button[data-testid="toolbar-button-present"]',
  'button[data-testid="toolbar-button-screenshare"]',
  'button[data-testid="toolbar-button-share"]',
  'button[data-testid="button-presentation"]',
  // Loose fallbacks — exclude the stop button AND the presentation-mode/expand
  // toggle (e.g. button-presentation-mode-toggle), which are NOT share buttons
  // and would otherwise be clicked instead, breaking the share flow.
  'button[data-testid*="present" i]:not([data-testid*="stop" i]):not([data-testid*="mode" i]):not([data-testid*="toggle" i])',
  'button[data-testid*="screenshare" i]',
  'button[data-testid*="share-screen" i]',
  'button[aria-label*="Share content" i]',
  'button[aria-label*="Share screen" i]',
  'button[aria-label*="Present" i]:not([aria-label*="Stop" i]):not([aria-label*="Expand" i])',
];

function findStartShareButton(doc: Document): HTMLElement | null {
  for (const sel of START_SHARE_SELECTORS) {
    const el = doc.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

/**
 * Wait until the webapp is ready for a fresh share: the "Start sharing" button
 * is present AND we are not currently the floor holder. Used after stopping
 * another presenter (take_floor/release_floor) so we don't click Share while
 * the webapp is still renegotiating — which silently no-ops the first attempt.
 * Resolves true when ready, false on timeout. Best-effort.
 */
export async function waitForShareReady(maxMs = 3000): Promise<boolean> {
  const win = getSameOriginParent();
  if (!win) return false;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (!isCurrentlyPresenting(win) && findStartShareButton(win.document)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** Wait for the "Share" button to appear after stopping (max waitMs). */
function waitForShareButton(doc: Document, waitMs: number): Promise<HTMLElement | null> {
  // Check immediately
  const existing = findStartShareButton(doc);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let done = false;
    const finish = (el: HTMLElement | null) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timeout);
      resolve(el);
    };

    const observer = new MutationObserver(() => {
      const btn = findStartShareButton(doc);
      if (btn) finish(btn);
    });
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid', 'aria-label'] });

    const timeout = setTimeout(() => finish(null), waitMs);
  });
}

/**
 * Install a one-shot getDisplayMedia intercept on the parent window.
 * Returns a restore function and a promise that resolves when intercepted.
 */
function installGetDisplayMediaIntercept(
  win: Window,
  stream: MediaStream,
): { restore: () => void; intercepted: Promise<void> } {
  const proto = Object.getPrototypeOf(win.navigator.mediaDevices);
  const origInstance = win.navigator.mediaDevices.getDisplayMedia?.bind(win.navigator.mediaDevices);
  const origProto = proto?.getDisplayMedia;

  let resolveIntercepted: () => void;
  const intercepted = new Promise<void>((r) => { resolveIntercepted = r; });

  const intercept = async function (this: MediaDevices) {
    restore();
    console.log(P, 'Strategy B: getDisplayMedia intercepted — injecting canvas stream');
    resolveIntercepted();
    return stream;
  };

  function restore() {
    try { win.navigator.mediaDevices.getDisplayMedia = origInstance!; } catch { /* */ }
    try { if (origProto) proto.getDisplayMedia = origProto; } catch { /* */ }
  }

  try { win.navigator.mediaDevices.getDisplayMedia = intercept; } catch { /* */ }
  try { if (proto) proto.getDisplayMedia = intercept; } catch { /* */ }

  return { restore, intercepted };
}

/** Watch for a popover/dialog and click the first matching "share" option. */
function watchForPopoverAndClickB(doc: Document): () => void {
  const OPTION_TEXT = /^(entire screen|screen|window|share|present|start)/i;
  let stopped = false;
  const cleanup = () => { stopped = true; observer.disconnect(); };

  const observer = new MutationObserver((mutations) => {
    if (stopped) return;
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        const candidates = [
          ...Array.from(node.querySelectorAll('button, [role="menuitem"], [role="option"], a, li')) as HTMLElement[],
        ];
        if (node.matches('button, [role="menuitem"], [role="option"], a, li')) {
          candidates.unshift(node);
        }
        for (const el of candidates) {
          const text = (el.textContent || '').trim();
          const testid = el.getAttribute('data-testid') || '';
          const aria = el.getAttribute('aria-label') || '';
          if (OPTION_TEXT.test(`${text} ${testid} ${aria}`)) {
            console.log(P, 'Strategy B: clicking popover option:', testid || text);
            setTimeout(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })), 50);
            cleanup();
            return;
          }
        }
      }
    }
  });

  observer.observe(doc.body, { childList: true, subtree: true });
  return cleanup;
}

async function presentViaStopAndRestart(
  canvas: HTMLCanvasElement,
  fps: number,
): Promise<PresentationHandle | null> {
  const win = getSameOriginParent();
  if (!win) return null;

  if (!isCurrentlyPresenting(win)) {
    console.log(P, 'Strategy B: not currently presenting — skipping stop-and-restart');
    return null;
  }

  console.log(P, 'Strategy B: already presenting — will stop, intercept getDisplayMedia, and restart');

  // Prepare the canvas stream
  const stream = canvas.captureStream(fps);
  const canvasTrack = stream.getVideoTracks()[0];
  if (!canvasTrack) {
    console.warn(P, 'Strategy B: canvas captureStream produced no video track');
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }

  // Step 1: Install getDisplayMedia intercept BEFORE stopping
  const { restore, intercepted } = installGetDisplayMediaIntercept(win, stream);

  // Step 2: Click "Stop sharing"
  const stopBtn = win.document.querySelector(
    'button[data-testid="button-stop-presentation"], button[aria-label*="Stop sharing" i]',
  ) as HTMLElement | null;

  if (!stopBtn) {
    console.warn(P, 'Strategy B: stop button vanished');
    restore();
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }

  console.log(P, 'Strategy B: clicking "Stop sharing"');
  stopBtn.click();

  // Step 3: Wait for the "Share" button to appear (webapp updates UI after release_floor)
  const shareBtn = await waitForShareButton(win.document, 4000);
  if (!shareBtn) {
    console.warn(P, 'Strategy B: share button did not appear within 4s');
    restore();
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }

  console.log(P, 'Strategy B: found share button:',
    shareBtn.getAttribute('data-testid') || shareBtn.getAttribute('aria-label'));

  // Step 4: Watch for any popover that might appear
  const stopWatching = watchForPopoverAndClickB(win.document);

  // Step 5: Click "Share" — webapp will call getDisplayMedia and get our stream
  console.log(P, 'Strategy B: clicking "Share" to trigger getDisplayMedia');
  shareBtn.click();

  // Step 6: Wait for interception or timeout
  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 6000));
  const result = await Promise.race([intercepted.then(() => 'ok' as const), timeout]);
  stopWatching();

  if (result === 'timeout') {
    console.warn(P, 'Strategy B: getDisplayMedia was not called within 6s');
    restore();
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }

  console.log(P, `Strategy B: SUCCESS — presenting canvas stream at ${fps} fps`);

  return {
    stop() {
      // Release the floor via the webapp's own button, then stop our tracks.
      clickStopPresentation(win);
      canvasTrack.stop();
      stream.getTracks().forEach((t) => t.stop());
      console.log(P, 'Strategy B: stopped presentation and canvas track');
    },
  };
}

// ---------------------------------------------------------------------------
// Strategy C — getDisplayMedia interception (when NOT already presenting)
// ---------------------------------------------------------------------------

async function presentViaShareOverride(
  canvas: HTMLCanvasElement,
  fps: number,
): Promise<PresentationHandle | null> {
  const win = getSameOriginParent();
  if (!win) return null;

  // Don't try if already presenting — Strategy B handles that case
  if (isCurrentlyPresenting(win)) {
    console.log(P, 'Strategy C: already presenting — skipping (Strategy B handles this)');
    return null;
  }

  const btn = findStartShareButton(win.document);
  if (!btn) {
    console.warn(P, 'Strategy C: could not find share button in webapp DOM');
    return null;
  }
  console.log(P, 'Strategy C: found share button:',
    btn.getAttribute('data-testid') || btn.getAttribute('aria-label') || btn.textContent?.trim());

  const stream = canvas.captureStream(fps);
  const { restore, intercepted } = installGetDisplayMediaIntercept(win, stream);

  const stopWatching = watchForPopoverAndClickB(win.document);
  btn.click();

  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 6000));
  const result = await Promise.race([intercepted.then(() => 'ok' as const), timeout]);
  stopWatching();

  if (result === 'timeout') {
    restore();
    stream.getTracks().forEach((t) => t.stop());
    console.warn(P, 'Strategy C: getDisplayMedia was not called within 6s');
    return null;
  }

  console.log(P, `Strategy C: SUCCESS — presenting canvas stream at ${fps} fps`);
  return {
    stop() {
      // Release the floor via the webapp's own button, then stop our tracks.
      clickStopPresentation(win);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function logDiagnostics(win: Window): void {
  console.group(P + ' — diagnostics (all strategies failed)');

  // pexDebug contents (most useful)
  try {
    const pd = (win as any).pexDebug;
    if (pd) {
      const lines: string[] = [];
      for (const key of Object.keys(pd)) {
        try {
          const v = pd[key];
          const t = v === null ? 'null' : typeof v;
          const subkeys = (t === 'object' && v) ? Object.keys(v).slice(0, 30).join(', ') : '';
          lines.push(`  ${key} (${t})${subkeys ? ': {' + subkeys + '}' : ''}`);
        } catch {
          lines.push(`  ${key} (inaccessible)`);
        }
      }
      console.log('pexDebug contents:\n' + lines.join('\n'));
    }
  } catch { /* */ }

  // Toolbar buttons
  try {
    const btns = Array.from(win.document.querySelectorAll('button'));
    const lines = btns.map((b, i) => {
      const testid = b.getAttribute('data-testid') || '';
      const aria = b.getAttribute('aria-label') || '';
      const text = (b.textContent || '').trim().slice(0, 50);
      return `  #${i}: testid="${testid}" aria="${aria}" text="${text}"`;
    });
    console.log('Parent buttons:\n' + lines.join('\n'));
  } catch { /* */ }

  console.log(
    'TIP: set window.__contentAnnotatorPresentPath = "path.to.client" ' +
      'in the parent console and retry.',
  );
  console.groupEnd();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PresentationHandle {
  stop: () => void;
}

/**
 * Attempt to present a canvas as a live content stream into the meeting.
 * Tries Strategy A → B → C, then returns null (manual fallback).
 */
export async function presentCanvas(
  canvas: HTMLCanvasElement,
  fps = 15,
): Promise<PresentationHandle | null> {
  const win = getSameOriginParent();

  // Check for a user-supplied path override
  if (win) {
    const manualPath = (win as any).__contentAnnotatorPresentPath;
    if (typeof manualPath === 'string') {
      const client = resolve(win, manualPath);
      if (client && typeof client.present === 'function') {
        console.log(P, `Using manual path "${manualPath}"`);
        const stream = canvas.captureStream(fps);
        const methods = wrapClient(client);
        methods.present(stream);
        return {
          stop() { methods.stopPresenting(); stream.getTracks().forEach((t) => t.stop()); },
        };
      }
      console.warn(P, `Manual path "${manualPath}" did not resolve to a present() function`);
    }
  }

  // Strategy A: direct client discovery
  const methods = findPresentMethods();
  if (methods) {
    const stream = canvas.captureStream(fps);
    methods.present(stream);
    console.log(P, 'Presenting via Strategy A at', fps, 'fps');
    return {
      stop() { methods.stopPresenting(); stream.getTracks().forEach((t) => t.stop()); },
    };
  }

  // Strategy B: stop-and-restart with getDisplayMedia interception
  const handleB = await presentViaStopAndRestart(canvas, fps);
  if (handleB) return handleB;

  // Strategy C: getDisplayMedia interception + share button click
  const handleC = await presentViaShareOverride(canvas, fps);
  if (handleC) return handleC;

  // All failed — diagnostics
  if (win) logDiagnostics(win);
  console.warn(P, 'All strategies failed — falling back to manual share');
  return null;
}

/**
 * Check whether programmatic presentation is likely available.
 */
export function canPresentProgrammatically(): boolean {
  const win = getSameOriginParent();
  if (!win) return false;
  if (findPresentMethods()) return true;
  if (isCurrentlyPresenting(win)) return true; // Strategy B can work
  if (findStartShareButton(win.document)) return true; // Strategy C can work
  return false;
}
