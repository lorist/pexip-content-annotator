# Pexip Content Annotator (webapp3 plugin)

Snapshot the **shared content/presentation stream** in a Pexip Infinity VMR,
**annotate** it on a canvas, **save** it as a PNG, and **share it back** into
the meeting as content. Pure plugin — no server, no extra participant.

- **Capture:** reads the presentation `<video>` element directly from the
  webapp's DOM and exports it via a canvas. The plugin is same-origin with the
  webapp in production (`allow-same-origin`), and the presentation video is
  MediaStream-backed, so the canvas is not CORS-tainted. No token, no frame id,
  no server. (See "How capture works" below for why the Client API paths don't
  work from the sandbox.)
- **Annotate:** a popup canvas editor (pen / line / arrow / rect / text,
  colours, widths, undo, clear).
- **Save:** local PNG download (plus best-effort "copy to clipboard").
- **Share back:** the "Share into meeting" button shows how to share the editor
  window via the meeting's *Share content* (the whole window, live).
- **Access:** all participants.

## Project layout

| Path | Role |
|---|---|
| `src/index.ts` | Plugin entry: toolbar button, popup handshake. |
| `src/capture.ts` | Captures the presentation `<video>` from the parent DOM. |
| `src/mock.ts` | Local-dev `@pexip/plugin-api` stand-in. |
| `public/editor.html` | Self-contained annotation editor (copied verbatim to `dist/`). |
| `branding-index.html` | Production plugin entry → copied to `dist/index.html`. |
| `index.html` | Dev-only vite entry. |
| `manifest.snippet.json` | The `plugins[]` entry to merge into an existing branding. |
| `scripts/package-branding.sh` | Builds a standalone test branding ZIP. |

## Develop

```bash
npm install
npm run dev          # vite dev server
```

Iterate on the editor directly at `http://localhost:5173/editor.html` — opened
without an opener it loads a placeholder image so all tools work standalone.

## Build & package

```bash
npm run build        # -> dist/ (assets/index.js, index.html, editor.html)
npm run package      # -> content-annotator-branding.zip (clean test branding)
```

The `dist/` contents go into the branding ZIP at
`webapp3/branding/plugins/content-annotator/`.

## Deploy

**Preferred (inject into an existing branding):** download a *real* branding via
the Management API, drop `dist/` into `plugins/content-annotator/`, merge
`manifest.snippet.json` into its `manifest.json` `plugins[]`, re-zip, and upload.
See the `pexip-webapp3-plugin` skill §4. Then point a webapp alias at the new
branding.

**Quick test:** `npm run package` builds a standalone branding ZIP you can
upload directly (do not clone the stock empty branding as a base).

## How capture works (and why)

The plugin reads the presentation `<video>` from the webapp DOM
(`captureFromParentDom` in [src/capture.ts](src/capture.ts)) and exports it via
canvas. This works because, in production, the plugin iframe is **same-origin**
with the webapp and has `allow-same-origin`, so `window.parent.document` is
reachable; and the presentation video is a **WebRTC MediaStream**, which is not
CORS-tainted, so `drawImage` → `toDataURL` is exportable.

This was chosen after the Client API approaches were proven unworkable from the
sandbox (all confirmed against a live deployment):

- `presentation_high.jpeg` needs an **integer `id`** — the SSE
  `presentation_frame` event id, which `@pexip/plugin-api` never exposes.
- `sendRequest` **strips URL query strings** (so `?id=` never arrives) and
  **cannot return binary** (a JPEG comes back as `undefined`).
- A direct `fetch` can carry `?id=` but the value is a string → the server
  rejects it as `invalid type for argument: id`, and the raw token isn't
  available to the plugin anyway.

**Limitations of the DOM approach:** capture resolution = the *rendered* video
size (may be lower than the source), and it depends on webapp3's DOM (a future
Pexip UI change could move/rename the element — the selector list and heuristic
in `captureFromParentDom` are designed to tolerate this, and log/return every
candidate `<video>` in the diagnostic if they miss).

> If full source resolution or a non-same-origin setup is ever needed, the
> capture can be moved to a small companion service that joins via the Client
> API, reads the real `presentation_frame` id from the SSE stream, and fetches
> `presentation_high.jpeg` server-side. Not required for the current solution.

## Send back into the meeting

There is **no plugin API to push content media**, and a page cannot trigger the
browser's screen-share picker (that needs a gesture inside the webapp). So the
editor's **"Share into meeting"** button just shows instructions: in the meeting
use **Share content → Window → "Annotator"**. That shares the whole editor
window (controls included), live, as you keep annotating.

## Notes / gotchas honoured

- Popup is opened **synchronously inside the click gesture** (avoids blockers);
  capture streams in afterwards via `postMessage`.
- Singleton guard uses a **silent return** on iframe reload (no noisy throw).
- Conference alias is seeded from the URL and updated from
  `authenticatedWithConference`.
- Button is hidden-of-effect when `presentationConnectionStateChange` reports no
  active content.
