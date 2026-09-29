---
"@alexkroman1/aai-ui": minor
"@alexkroman1/aai": patch
---

A browser page can now be reached after the call, the way a device is: the browser half of `WS /inbox`, a client id the SDK keeps, and the current session id as a hook.

- `mountClient({ client: "auto" })` (and `createBrowserSession({ client: "auto" })`) has the SDK mint and keep this browser's client id — `browserClientId()`, `browser-<32 hex>` in `localStorage` per agent URL, per-tab where storage is unavailable. An explicit string or getter `client` works as before, so `"auto"` itself can no longer be a client id.
- `useInbox({ onNotice, onEvent, busy, play, events })` holds the session's client inbox open (reconnecting on a jittered 1 s → 30 s backoff), answers busy while the session is running so a reminder never talks over a reply, acks a repeat without replaying it, and plays each notice (PCM16LE mono, 16 kHz) once the page's first click or keypress has unlocked audio. Returns `{ connected, stopPlayback }`. `createInbox()` is the same thing without React.
- The inbox holder id is per TAB, so two tabs of one browser coexist as holders of one client instead of replacing each other's inbox socket once a second.
- One tab plays a notice: the one last clicked or typed in, claimed in `localStorage`. Every tab still acks it and still gets `onNotice`; with no claim (or no storage) every unlocked tab plays, as before. Nine open tabs had played each notice nine times, a few milliseconds apart.
- `useSessionId()` is the server's id for the current session (`undefined` before its first `config` frame and after `end()`), and `useClientId()` the id the session sends. `session.identity` carries both, the tab's holder id and the base URL.
- `CLIENT_ID_RE` is on `@alexkroman1/aai/internal`, so the browser checks ids against the one rule the server uses.
