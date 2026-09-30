---
"@alexkroman1/aai-ui": minor
---

What a device's browser twin page kept writing for itself, in the kit:

- **`useTapToTalk({ key, idleHangupMs, thinkingHangupMs, connectTimeoutMs })`** — tap to go live, tap to hang up, for an automatic-turn agent: `{ phase, live, failed, toggle, send, hangUp, buttonProps }`. Hang-up is `disconnect()` (the next tap resumes), the mic is muted unless live, a typed turn opens the session without the mic, a call that is not live hangs itself up after `idleHangupMs` quiet (3 s) or `thinkingHangupMs` thinking (60 s), a connection that takes longer than `connectTimeoutMs` (8 s) fails, and the session dropping leaves live mode. The talk key (Space) ignores auto-repeat and text fields.
- **`session.sendText(text, { connect: true })`** (`SendTextOptions`) — opens the session if it is not up (`start()`, or `toggle()` after a hang-up so it resumes) and sends once it is configured, in order; dropped if the session stops first. Without the option, sending while disconnected still does nothing.
- **`useConversationLog({ storageKey, max })`** — `{ entries, addNote, addSpoken, mirror, clear }`: a transcript across resumable sessions, persisted in `localStorage` (300 entries), with a resumed session's replay logged once. `mirror` is a handler for the page's own `useInbox({ onEvent })` that logs the client's other sessions. `inboxEventToItem(event, id?)` is the row for one mirrored frame; `ConversationLogEntry` is the stored shape.
- **`<ConversationView log>`** (and `<MessageList log>`) render those entries in place of the live items, with `renderNote` and `renderSessionHeader` slots.
- **`routeFetch(method, path, body?, { client, baseUrl, signal })`** and **`useRoute(path, { pollMs, client })`** — the agent's own `agent({ routes })` under `/api`, resolved against the page's directory, with `?client=` (by default the session's, in `useRoute`) and the route's `{ error }` as the thrown message.
- **`createStoredValue(key, { initial, storage })`** / **`useStoredValue(keyOrValue, initial?)`** — a remembered string, readable in a getter outside React, synced across holders and tabs; `""` forgets it.
- **`createLinkedClient({ key, fallback })`** — `{ id, linked, own, set, clear }`: the linked device's client id, validated, else `browserClientId()`.
- **`phoneE164(typed, { countryCode })`** — a typed number in the E.164 form the session's `phone` must carry, or `undefined`; `countryCode` says which country a number typed without one means.
