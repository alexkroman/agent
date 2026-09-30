---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Helpers for the code an agent had been writing for itself around vendor APIs,
routes and texts:

- `jsonClient({ baseUrl, headers, label, errorMessage? })` and `HttpError` on
  `@alexkroman1/aai/utils`: one JSON REST API declared once, called as
  `(ctx, method, path, body?)`, throwing `"<label> <status>: <what it said>"`.
- `fetchJson` (`@alexkroman1/aai/tools`) takes `method` and a JSON `body`.
- `verifyStandardWebhook(req, secret)` and `webhookRoute({ secretEnv }, handler)`
  on the root: Standard Webhooks signatures, with the replay window, rotated
  signatures and a constant-time compare.
- `route({ body, requireClient, handler })` and `routeError(status, message)` /
  `RouteError` on the root: a route's body validated against a Standard Schema
  and `?client=` required, each a 400; a thrown `routeError` answers its status
  instead of a 500 (the runtime's route dispatcher recognizes it).
- `requireSessionClient(ctx, message?)` on the root: the session's client id or
  a `ToolFailure`.
- `fitToolResult(value, { maxChars, maxString, hint })` and
  `normalizePhone(raw, { defaultCountry })` on `@alexkroman1/aai/utils`.
- `textbeltChannel({ key, to, links: "strip" })`, and `TEXTBELT_LINKS=strip` in
  the agent env makes the `text_me` builtin leave links out — for a Textbelt key
  not yet allowed to send them.
