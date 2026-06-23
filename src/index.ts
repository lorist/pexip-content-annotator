import { registerPlugin } from '@pexip/plugin-api';
import { captureContentFrame } from './capture';
import { createMockPlugin } from './mock';

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

  // The editor popup (opened by the host via opensPopup) can't call the plugin
  // RPC itself, so it asks us to capture over a same-origin BroadcastChannel.
  const channel =
    typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(CHANNEL)
      : null;

  channel?.addEventListener('message', async (ev: MessageEvent) => {
    if (ev.data?.type !== 'request-capture') return;
    const reqId = ev.data.reqId;
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
  });

  // Host opens the popup within the real click gesture (avoids popup blockers).
  // Resolve the editor URL absolutely from THIS plugin's location, because the
  // host opens it relative to the top page, not the plugin folder.
  const editorUrl = new URL('./editor.html', location.href).href;

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
