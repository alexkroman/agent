---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
---

Replace the mixed binary/JSON client↔server WebSocket protocol with a single tagged binary wire format. Unify session.ts + pipeline-session.ts into SessionCore with two transport strategies (S2S, pipeline). No behavior change visible to end users; all internal. See docs/superpowers/specs/2026-04-23-websocket-middle-hop-consolidation-design.md.
