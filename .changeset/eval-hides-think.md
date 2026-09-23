---
"@alexkroman1/aai-runtime": patch
"aai-templates": patch
---

Eval sessions leave the `think` builtin's scratchpad calls out of `EvalTurn.toolCalls` and `session.toolCalls()` (an authored `tools/think.ts` is still recorded; `events` are unchanged), and `judgeCall` no longer sends `temperature`, which the gateway's GPT-5 models reject. Templates drop `temperature` for the same reason, research-planner's replan schema is strict-mode compatible and no longer re-queues a finished step when the replan fails, and text-adventure pins the golden chalice to the Pine Forest.
