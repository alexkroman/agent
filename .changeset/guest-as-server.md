---
"@alexkroman1/aai": minor
---

Deployed agents now run as SERVERS — the "guest is a server" contract. The
worker bundle (sha-256-verified in the guest) and the agent env arrive as
files written into the sandbox before exec; readiness is the guest's public
`/health`; and the platform's whole ongoing surface is a token-gated
`GET /manage/status` + `POST /manage/drain` pair. No control channel exists
on an agent sandbox: lifecycle is guest-owned (idle self-exit replaces the
orphan timeout; a drained guest refuses new sessions and exits when empty),
and a boot crash fails the spawn immediately with the guest's stderr. The
JSON-RPC control channel remains for studio/inspect sandboxes only, which
always run the current harness image. Combined with per-deploy image
pinning, the platform↔deployed-agent contract is now an exec convention
plus five HTTP endpoints, frozen per deploy.
