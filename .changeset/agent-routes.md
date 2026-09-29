---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
"@alexkroman1/aai-cli": patch
---

`agent({ routes })`: the app's own JSON endpoints, served under `/api` by `createRuntimeServer` (so `aai dev` — its Vite proxy included — `aai start` and self-hosted servers).

- Keys are `"<METHOD> /<path>"` with `:param` segments — `"GET /memories"`, `"DELETE /memories/:id"` — for `GET`, `POST`, `PUT`, `PATCH` and `DELETE`. A malformed key, or two keys matching the same requests, fails the runtime's start.
- A handler gets `req` (`method`, `path` without `/api`, decoded `params`, `query`, `headers` with lower-cased names, a parsed JSON `body` and its exact text as `rawBody` — what a webhook signature is verified against — a validated `clientId` from `?client=`) and `ctx` (`env`, `workflows`, `clientTranscript(clientId, options?)` over the runtime's own client log, and `signal`). Its return value is sent as JSON 200 (`undefined` as `null`); `routeResponse(status, body)` answers any 2xx/4xx/5xx; a throw is a 500 `{ error }` with the message only.
- Bodies are capped at 64 KiB (413) and must be JSON (400). An unknown path is a 404, a known path with the wrong method a 405 with `Allow`. An agent with no routes leaves `/api` to static serving.
- No authentication is added: the routes are as open as the server — on a LAN address, anyone who can reach it — and a handler sees the request's cookies and `Authorization` header. Self-hosted only for now: the platform exposes no `/:slug/api`.
