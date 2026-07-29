---
"aai-server": patch
---

Fix the deployed `send:` channel: carry the descriptor onto the runtime agent so the `send_message` builtin is registered, and derive the channel's webhook host into the sandbox's `allowedHosts` so guest tool code can post through `openSender`.
