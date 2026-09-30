---
"@alexkroman1/aai": minor
---

Add speech.say / speech.interrupt: put an exact sentence on a live call from any code, stop the agent server-side, and await one line's playout. ctx.speech is on an events handler's and a tool's context, and RouteContext.speech(sessionId) reaches a live call from a webhook route. A say is a verbatim reply of its own (no model call): queued behind the reply in flight unless { interrupt: true }, interruptible, and recorded in history as what was heard; its handle's done settles played, interrupted, dropped, or unsupported (S2S agents: pipeline only). interrupt() is the client's cancel(). createToolContext() records says into ctx.said. A spec that hand-builds a SessionEventContext literal must now add speech; passing createToolContext() works as before.
