---
"aai-studio-server": patch
---

Repair a GitHub App private key whose newlines were collapsed to spaces.

The production key was pasted through a single-line field, arriving with 32
spaces and zero newlines. `normalizePrivateKey` short-circuits on
`includes("-----BEGIN")`, so it handed the value straight to OpenSSL, which
refused it with `error:1E08010C:DECODER routines::unsupported` — at the LAST
step of the install callback, after GitHub had already authorized the user, so
it surfaced as "GitHub could not complete the connection" rather than as a
misconfiguration. The repair is structural rather than a whitespace
substitution: the PEM label legitimately contains spaces, so it reads the
header and footer and re-wraps the body at 64. Deterministic and idempotent,
because this value is also the HMAC key behind every install `state`.
