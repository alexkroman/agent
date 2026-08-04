---
"aai-studio-server": patch
---

Allow the Supabase auth origin in the studio page's connect-src, so magic-link sign-in is not blocked by CSP (it failed as a bare "Failed to fetch" with nothing on the server)
