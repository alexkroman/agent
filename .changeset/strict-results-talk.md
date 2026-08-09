---
---

Close four findings from the server security audit. Private packages only
(`aai-server`, `aai-studio-server`), so no published release.

- Raw API-key bearers are now verified against AssemblyAI before they mean
  anything. Every other check on the platform was relative to an agent row,
  so the routes in front of ownership — deploy, studio project-create, the
  session broker — accepted any bearer string.
- `POST /deploy` bounds how many request bodies buffer at once, so peak
  memory stops being a function of arrival rate.
- Rate limits are keyed by client IP as well as by scope; the scope key was
  derived from the caller's own bearer, so rotating it minted a fresh window.
- A key already linked to one account can no longer be rebound by another.
