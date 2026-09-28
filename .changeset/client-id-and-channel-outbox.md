---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
"@alexkroman1/aai-ui": minor
---

A browser client can name itself, and channel sends can be captured instead of sent.

- `createBrowserSession()` and `mountClient()` take a `client` option (a string, or a getter asked on every connection attempt), sent as `?client=` on each connect. It is the id `sessionClientId(ctx)` returns and the one a client holds `WS /inbox?client=` open under, so a workflow run's `stepNotifyClient` can reach the browser after the session ends. An empty answer sends nothing; the server ignores an id that is not letters, digits, `-` and `_`.
- Set `AAI_CHANNEL_OUTBOX` to a file path in the shell that runs `aai dev` (or any `createRuntimeServer`) and every channel send (the `text_me` builtin, `sendToChannel` / `sendToChannelOrFail` in a step) is appended to that file as one JSON line, `{ at, kind, to, body }`, and reported as delivered. Nothing is sent. The entry never carries a credential: Textbelt's `key` is removed and no URL is written (a Slack webhook URL is the secret). The log says the kind and the length, never the number or the text.
