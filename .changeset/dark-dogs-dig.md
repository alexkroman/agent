---
"@alexkroman1/aai-cli": patch
"aai-studio-client": patch
---

Harden the aai login device link: the terminal and the browser approval gate now show a matching confirmation code (a phished approval link has a visible mismatch), and the studio stashes the ?cli-link code in per-tab sessionStorage and strips it from the URL at page load so it never rides the GitHub OAuth redirect chain.
