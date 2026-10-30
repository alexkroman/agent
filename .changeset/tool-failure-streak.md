---
"@alexkroman1/aai-runtime": patch
"@alexkroman1/aai": patch
---

A tool that keeps failing now tells the model to change strategy. The
failed-call note already listed every failed attempt and refused an exact
repeat, but a model that changed one character per call never tripped it: on a
tau2-bench retail run one call sent ten email variants across three turns and
never switched identifier. Once one tool has failed four times since the last
success, the note now also says to stop varying the value and either look the
caller up by a different identifier or read back what it has and ask them to
spell it. Four, not three, because the prompt's own spelling-recovery ladder
legitimately takes about four lookups. In an offline replay of that call,
guessing another variant after the fourth failure fell from 7 of 20 samples to 1
of 20.

The default system prompt's TOOLS section also says that a choice from a fixed
list (a reason, a category, a payment method) is the caller's to give: ask for
it rather than sending the first or likeliest option. The same run's agent
recorded every cancellation as "no longer needed" without asking.
