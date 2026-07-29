---
---

Studio: store the platform API key in `sessionStorage` instead of `localStorage`.
The key is the caller's full account credential, and deployed tenant agents are
served from the same web origin as the studio, so persisting it in shared,
cross-tab storage let a malicious tenant's agent page read a studio user's key.
Scoping it to the studio's own browsing context closes that path.
