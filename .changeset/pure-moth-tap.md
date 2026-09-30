---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

SDK primitives for one-time codes, call status and device announcements: mintDigitCode/hashCode/codeMatches (unbiased draw, hashed storage, constant-time spoken read-back), CALL_OVER_STATUSES/isCallOver on /step, ctx.sayOnClient on WorkflowContext (one journaled announcement step, id defaulting to the run id and maxAttempts to DEFAULT_CLIENT_DELIVERY_ATTEMPTS), sayFailureOnClient on /step as a workflow({ onFailure }) handler (also accepted by deepResearchWorkflow), and stepTextOwner on /step, the text_me builtin's recipient rule and refusal classification from a workflow step.
