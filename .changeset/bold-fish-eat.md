---
"aai-studio-server": patch
---

Studio GitHub: route the OAuth code exchange and the user-installations check
through Octokit (`@octokit/oauth-methods`, `@octokit/plugin-paginate-rest`)
instead of raw fetch, and recognise GitHub errors by `RequestError`.
