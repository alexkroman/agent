---
"aai-studio-server": patch
---

Studio front-end: the gate card — the studio's last-resort error screen — was a fixed 420px and put the server's own error text through no wrapping guard, so an upstream message carrying one unbroken token (a URL, a request id, a base64 fragment) blew the card past the viewport: measured 1266px of content in a 338px column. It is now a max-width that also fits a narrow window, and both the message and the detail break long tokens. The top bar could not shrink below ~830px either, so the action buttons ran off the right edge of any window narrower than that; the published-URL link now yields first and the wordmark hides below lg, which clears it down to ~690px.
