---
"@alexkroman1/aai-runtime": minor
---

The eval judge reads both sides of a conversation. Handed a list of `EvalTurn`s it now includes what the user said on each turn (it used to render the agent's tool calls and replies only, so a criterion about the other party's words had no evidence), and `judge`/`judgeCall` also take a session — `evalSimulation(...).judge(session, criteria)` — reading the whole conversation, uncut.
