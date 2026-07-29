---
"aai-server": patch
---

Grade the studio coding agent against the aai-templates templates. The studio
eval suite gains six one-shot codegen cases whose prompts are the studio's own
starter prompts, each judged for functional parity against the hand-written
template it was modeled on (`TemplateParityJudge`, a 5-criterion rubric over
mode, capability coverage, kv/session state, assets, and persona constraints),
plus a guard test that every template is either evaluated or explicitly excused.

Two fixes came out of running it: the studio prompt now tells the coding agent
to cover every capability the user enumerated rather than folding several into
one tool, and `transport-websocket.test.ts` no longer leaks a pending
`aai_sessions_active` decrement across test boundaries — teardown waited on the
client socket, not the server-side close that owns the metric, so the gauge
could read -1 in whichever test ran next.
