import { registerPlugin } from '@pexip/plugin-api';
import { captureContentFrame } from './capture';
import { createMockPlugin } from './mock';
import {
  presentCanvas,
  canPresentProgrammatically,
  watchForPresentationEnd,
  waitForShareReady,
  type PresentationHandle,
} from './present';

const PLUGIN_ID = 'content-annotator';
const CHANNEL = 'content-annotator';

// Not inside the webapp iframe => local dev (vite).
const isLocalDev =
  location.hostname === 'localhost' && window.parent === window;

/**
 * Best-effort conference alias; the authoritative value arrives via the
 * authenticatedWithConference event. Do NOT fall back to this iframe's own
 * pathname — inside the plugin that's the branding path, not the conference.
 */
function getConferenceAlias(): string {
  const fromHash = (h: string) =>
    new URLSearchParams(h.split('?')[1] || '').get('conference') || '';
  if (fromHash(location.hash)) return fromHash(location.hash);
  try {
    if (fromHash(window.parent.location.hash))
      return fromHash(window.parent.location.hash);
    // Top webapp meeting URL is typically /<path>/m/<alias>.
    const m = window.parent.location.pathname.match(/\/m\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch {
    /* cross-origin parent */
  }
  return '';
}

async function init(): Promise<void> {
  const plugin: any = isLocalDev
    ? createMockPlugin()
    : await registerPlugin({ id: PLUGIN_ID, version: 1 });

  let alias = getConferenceAlias();
  plugin.events.authenticatedWithConference?.add((info: any) => {
    alias = info?.conferenceAlias || info?.conference_alias || alias;
  });

  // Track our own participant (for take_floor) and who else is presenting, so
  // we can steal the floor via the Client API when taking over.
  let me: any = null;
  let otherPresenters: { uuid: string; name: string }[] = [];
  plugin.events.me?.add?.((ev: any) => {
    me = ev?.participant || ev;
  });
  plugin.events.participants?.add?.((ev: any) => {
    const list = ev?.participants || [];
    otherPresenters = list
      .filter((p: any) => p.isPresenting && p.uuid !== me?.uuid)
      .map((p: any) => ({ uuid: p.uuid, name: p.displayName || 'Someone' }));
  });

  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Stop whoever is currently presenting via the Client API: POST take_floor on
  // our OWN uuid grabs the floor (booting the current presenter), then
  // release_floor frees it again so nobody is presenting. This leaves the
  // webapp in a clean "no presentation" state, so our own share afterwards is a
  // plain first-share with no native take-over dialog. See
  // pexip/webapp3-plugin-stop-presenter for the take_floor/release_floor pattern.
  async function stopCurrentPresenter(): Promise<void> {
    if (!me?.uuid) {
      console.warn('[content-annotator] cannot stop presenter — own uuid unknown');
      return;
    }
    const post = (action: string) =>
      plugin.conference.sendRequest({
        path: `participants/${me.uuid}/${action}`,
        method: 'POST',
        payload: {},
      });
    try {
      await post('take_floor'); // grab the floor → boots the current presenter
      await wait(1000);
      await post('release_floor'); // free it → nobody is presenting now
      // Wait until the webapp has settled and is ready for a fresh share,
      // rather than guessing a fixed delay — sharing too soon after
      // release_floor silently no-ops and leaves the editor not presenting.
      const ready = await waitForShareReady(3000);
      await wait(ready ? 400 : 1200);
      console.log('[content-annotator] stopped current presenter; share ready =', ready);
    } catch (err) {
      console.warn('[content-annotator] stop-presenter failed', err);
    }
  }

  // The editor popup (opened by the host via opensPopup) can't call the plugin
  // RPC itself, so it asks us to capture over a same-origin BroadcastChannel.
  const channel =
    typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(CHANNEL)
      : null;

  // Track an active presentation so we can stop it. `presentStarting` guards
  // the async start window (prompt → steal floor → presentCanvas) BEFORE
  // `activePresentation` is set, so a duplicate start-presenting message can't
  // run the take-over (and its confirmation dialog) a second time.
  let activePresentation: PresentationHandle | null = null;
  let presentStarting = false;

  channel?.addEventListener('message', async (ev: MessageEvent) => {
    const { type, reqId } = ev.data ?? {};

    if (type === 'request-capture') {
      try {
        const dataUrl = await captureContentFrame();
        channel.postMessage({ type: 'image', reqId, dataUrl, alias });
      } catch (err) {
        console.error('[content-annotator] capture failed', err);
        channel.postMessage({
          type: 'error',
          reqId,
          message: (err as any)?.message || 'No content could be captured.',
        });
      }
      return;
    }

    if (type === 'check-can-present') {
      channel.postMessage({
        type: 'can-present-result',
        reqId,
        available: canPresentProgrammatically(),
      });
      return;
    }

    if (type === 'start-presenting') {
      // The editor sends us its canvas as an OffscreenCanvas or, more
      // practically, it keeps drawing locally and we relay its
      // captureStream. But the editor is in a popup (different window) so
      // we can't access its canvas. Instead we create a local hidden
      // canvas, load the editor's current image into it, and the editor
      // sends us frame updates over the channel.
      //
      // Simpler approach: the editor captures its own canvas stream and
      // we can't transfer MediaStreams over BroadcastChannel. So the
      // actual present() call must happen HERE in the plugin iframe
      // (same-origin with the webapp). We ask the editor to stream
      // frames to us as ImageBitmaps via a dedicated MessageChannel.
      //
      // Pragmatic approach: we create a local canvas, the editor sends
      // us data-URL frames at ~5fps, we paint them and present() that.
      console.log('[content-annotator] start-presenting requested');
      // Idempotent: if we're already presenting, do NOT tear down and rebuild.
      // Doing so races release_floor against the still-visible "Stop sharing"
      // button and lands in the wrong re-share path (clicking the
      // presentation-mode toggle), which fails into the manual fallback. The
      // existing frame stream keeps the content live, so just re-confirm.
      if (activePresentation || presentStarting) {
        console.log('[content-annotator] already presenting/starting — ignoring duplicate start');
        channel.postMessage({ type: 'present-status', reqId, ok: true });
        return;
      }
      presentStarting = true;

      // If someone else is presenting, ask the EDITOR to confirm the take-over
      // (the dialog is shown in the editor window, not the webapp). The editor
      // re-sends start-presenting with confirmTakeover once the user agrees.
      if (otherPresenters.length > 0 && !ev.data.confirmTakeover) {
        console.log('[content-annotator] another participant is presenting — asking editor to confirm');
        presentStarting = false;
        channel.postMessage({
          type: 'present-status',
          reqId,
          ok: false,
          needsConfirm: true,
          presenterName: otherPresenters[0].name,
        });
        return;
      }

      // Confirmed (or nobody else was presenting): stop the current presenter
      // via the API so our content takes a clean, dialog-free first-share slot.
      if (otherPresenters.length > 0) {
        await stopCurrentPresenter();
      }

      const offscreen = document.createElement('canvas');
      offscreen.width = ev.data.width || 1280;
      offscreen.height = ev.data.height || 720;
      const ctx = offscreen.getContext('2d')!;

      // Paint the editor's current frame BEFORE presenting, so the first frame
      // the conference sees is the real annotated content — never a black
      // canvas. Taking over an existing presentation renegotiates immediately
      // (take_floor), so a blank canvas at that instant is exactly what
      // produced the black screen.
      if (ev.data.dataUrl) {
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            offscreen.width = img.naturalWidth || offscreen.width;
            offscreen.height = img.naturalHeight || offscreen.height;
            ctx.drawImage(img, 0, 0);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = ev.data.dataUrl;
        });
      }

      const handle = await presentCanvas(offscreen);
      if (!handle) {
        presentStarting = false;
        channel.postMessage({
          type: 'present-status',
          reqId,
          ok: false,
          reason: 'Webapp present() not available — use manual Share Content instead.',
        });
        return;
      }
      activePresentation = handle;
      presentStarting = false;

      // Listen for frame updates from the editor.
      let lastFrameAt = Date.now();
      let gotFirstFrame = false;
      const onFrame = (fe: MessageEvent) => {
        if (fe.data?.type !== 'present-frame') return;
        lastFrameAt = Date.now();
        gotFirstFrame = true;
        const img = new Image();
        img.onload = () => {
          offscreen.width = img.naturalWidth || offscreen.width;
          offscreen.height = img.naturalHeight || offscreen.height;
          ctx.drawImage(img, 0, 0);
        };
        img.src = fe.data.dataUrl;
      };
      channel.addEventListener('message', onFrame);

      // Watchdog: once the editor's live frame stream has started (~5fps), a
      // gap means the editor window was closed/crashed without a clean
      // stop-presenting message — end the presentation so we don't keep
      // sharing a frozen frame. We only arm this AFTER the first frame so a
      // slow editor start (or one that never streams) can't kill a working
      // presentation of the initial painted frame.
      const watchdog = window.setInterval(() => {
        if (gotFirstFrame && Date.now() - lastFrameAt > 3000) {
          console.log('[content-annotator] editor frames stopped — ending presentation');
          activePresentation?.stop();
        }
      }, 1000);

      // Detect another participant taking over the floor: the webapp's
      // "Stop sharing" button disappears even though we never stopped. When
      // that happens, tear down our side and tell the editor to flip its
      // button back to "Share into meeting".
      const stopMonitor = watchForPresentationEnd(() => {
        channel.postMessage({ type: 'present-ended', reason: 'taken-over' });
        activePresentation?.stop();
      });

      // When presenting stops, clean up the frame listener, watchdog, monitor.
      const origStop = handle.stop;
      handle.stop = () => {
        clearInterval(watchdog);
        stopMonitor();
        channel.removeEventListener('message', onFrame);
        origStop();
        activePresentation = null;
      };

      channel.postMessage({ type: 'present-status', reqId, ok: true });
      plugin.ui.showToast({ message: 'Sharing annotated content into meeting ✓' });
      return;
    }

    if (type === 'stop-presenting') {
      activePresentation?.stop();
      activePresentation = null;
      channel.postMessage({ type: 'present-status', reqId, ok: true, stopped: true });
      return;
    }
  });

  // Host opens the popup within the real click gesture (avoids popup blockers).
  // Resolve the editor URL absolutely from THIS plugin's location, because the
  // host opens it relative to the top page, not the plugin folder.
  // Cache-bust with a build-time version so browser cache doesn't serve stale editor.html.
  declare const __BUILD_VERSION__: string;
  const buildVer = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev';
  const editorUrl = new URL(`./editor.html?v=${buildVer}`, location.href).href;

  // Built-in IconEdit (verified valid on this deployment). If a future Pexip
  // version rejects it with "Invalid Icon name", swap to a custom data-URL SVG:
  //   icon: { custom: { main: <dataUrl>, hover: <dataUrl> } }
  const btn = await plugin.ui.addButton({
    position: 'toolbar',
    icon: 'IconEdit',
    tooltip: 'Snapshot & annotate the shared content',
    opensPopup: {
      id: 'content-annotator-editor',
      openParams: [
        editorUrl,
        'pexip-content-annotator',
        'width=1280,height=860,resizable=yes,scrollbars=yes',
      ],
    },
  });
  // Also drive capture from the click itself and report the outcome IN the
  // webapp (toast + modal). This makes the result visible even when the editor
  // popup is blocked (e.g. http://localhost in dev), and answers the capture
  // question without the console. An open editor also receives the image via
  // the channel broadcast below.
  btn.onClick?.add?.(async () => {
    console.log('[content-annotator] snapshot button clicked');
    try {
      const dataUrl = await captureContentFrame();
      channel?.postMessage({ type: 'image', dataUrl, alias }); // editor (if open) renders it
      plugin.ui.showToast({ message: 'Content captured ✓' });
    } catch (err: any) {
      const detail = String(err?.message || err || 'capture failed');
      plugin.ui.showToast({ message: 'Content capture failed', isDanger: true });
      try {
        await plugin.ui.showForm({
          title: 'Content capture failed',
          description: detail.slice(0, 1800),
          form: {
            elements: {
              detail: {
                name: 'Server response',
                type: 'text',
                isOptional: true,
                value: detail.slice(0, 500),
              },
            },
            submitBtnTitle: 'Close',
          },
        });
      } catch {
        /* form unsupported — toast already shown */
      }
    }
  });

  console.log(
    `[content-annotator] initialised (alias="${alias}", dev=${isLocalDev}, editor=${editorUrl})`,
  );
}

// Singleton guard — silent return (not throw) on plugin iframe reload.
if ((globalThis as any).__contentAnnotatorInit) {
  console.log('[content-annotator] already initialised, skipping');
} else {
  (globalThis as any).__contentAnnotatorInit = true;
  init().catch((e: any) => {
    // Surface a real message/stack — bare objects log as "Object".
    console.error(
      '[content-annotator] init error:',
      e?.message ?? e,
      '\nstack:',
      e?.stack ?? '(none)',
      '\nraw:',
      (() => {
        try {
          return JSON.stringify(e, Object.getOwnPropertyNames(e ?? {}));
        } catch {
          return String(e);
        }
      })(),
    );
  });
}
