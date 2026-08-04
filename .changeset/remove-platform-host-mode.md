---
"@alexkroman1/aai": patch
---

Remove platform host mode (`?host=1` on deployed agents). The platform no
longer runs any session in the server process: `/:slug/websocket` upgrades
are always handshake redirects to the agent's live sandbox. This deletes the
one path where the server's current SDK interpreted stored agent configs
(`toRuntimeAgent`), a cross-version seam for already-deployed bundles. Host
mode remains available under `aai dev`.
