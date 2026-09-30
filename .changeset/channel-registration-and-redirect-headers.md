---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": patch
---

Channel credentials and refusals are declared per kind, and redirects no longer
replay a caller's headers to another origin.

- `registerChannelHandler` takes an optional `ChannelRegistration`
  (`{ refusal?, credentialFields? }`), stored with the handler. A 2xx-refusal
  reader and the credential fields redacted from errors and stripped from a
  channel outbox are now the registered kind's own — Textbelt declares `key`,
  Slack `webhookUrl` — so a third-party channel can declare its secret, and a
  body field named `key` is no longer dropped from a kind that did not declare
  it.
- Once a redirect leaves the original origin, `safeFetch` and the contained
  builtin fetch drop every caller-set header except `accept`,
  `accept-language`, `content-type` and `user-agent` (so a `fetchJson`
  `x-goog-api-key` or an MCP server's `x-api-key` is never replayed).
  `credentialSafeFetch` and `ssrfSafeFetch`'s `extraCredentialHeaders` are
  removed from `/host-internal`.
- `fetchJson` answers a network failure or SSRF refusal as `{ error, url }`
  instead of throwing, like every other failure.
- Composio's key scrub also catches the key URL-encoded and secret-named query
  parameters.
