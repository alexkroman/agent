---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Remove `verify_action`, turn coalescing, and the recognizer-steering seam — none of them earned their keep.

**`listen_for` and `ctx.steerRecognizer` were measured and came back NULL.** On tau2-bench retail at concurrency 5, matched per task against an otherwise identical run: **0.212 with the tool against 0.230 without, n=113, +15/−17/=81, McNemar p=0.86** — and not for want of use, since the tool was called **184 times across 81 of 114 sessions** with every term correctly filtered to something a caller can actually say. The premise was that biasing the recognizer toward a looked-up name would fix the measured name collapse ("Yusuf" → "Yuta" → "Yufus"); 81 sessions of correctly-targeted biasing moved nothing. The likelier reading is the one the transcripts already suggested: those calls fail AFTER a clean transcript, so this was a recognition fix for a reasoning failure.

**`verify_action` was never validly measured.** Its one A/B was three tasks, 12 sims, every one scoring 0.000 in both arms, with the arms unbalanced 3 against 9 — a comparison with no resolving power. Nothing on disk even records whether the tool was enabled in the arm, because a host-side builtin leaves no trace in the harness's artifacts. Its own author predicted this: it buys at most 13 of 58 failures and pays a tool call on every write, on a benchmark where a reply's chance of being cancelled before the caller hears it scales steeply with calls in the gap (15% at none, 75% at six or more).

**Turn coalescing goes for a different reason: it was never isolated.** It has been live in every run since 2026-09-11 and no arm has ever measured it, so its effect on the score is unknown in both directions. What it fixed is real and described — a caller prodding a stall got answered twice — and it can come back with a measurement behind it.

`TurnChain.coalesce`, `createTurnDoors`, `SessionKeyterms`, `Transport.steerRecognizer`, `ServerSession.steerRecognizer`, `ToolContext.steerRecognizer`, the `additional` parameter on `SttSession.updateKeyterms`, and the two builtins go with them. `DEFAULT_BUILTIN_TOOLS` is empty again, which restores the rule the exception was argued against: a builtin is something an agent asks for.
