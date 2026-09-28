---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
"@alexkroman1/aai-ui": minor
---

A client can report its owner's phone number, the way it reports its location.

- `createBrowserSession()` and `mountClient()` take a `phone` option (a string, or a getter asked on every connection attempt), sent as `?phone=` on each connect: first, resume and reconnect, brokered or not. An empty answer sends nothing.
- The server normalizes `?phone=` to E.164. It strips spaces, dashes, dots and parentheses, then requires a `+` and 8–15 digits. A bare 10-digit number is not assumed to be North American. An invalid value is dropped with one warning that does not include it. A valid one is kept per session (new `SessionStartOptions.clientPhone`) and never logged.
- `sessionClientPhone(ctx)` on `@alexkroman1/aai` returns it. It is whatever the client claimed and nothing verifies it, so don't text it directly. Pass it through `allowedSmsRecipient` (`@alexkroman1/aai/channels`) first.
- `createToolContext({ clientPhone })` in `@alexkroman1/aai/testing` sets the value `sessionClientPhone(ctx)` returns, the same way `clientId` does for `sessionClientId`.
