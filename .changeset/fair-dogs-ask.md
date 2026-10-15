---
"@alexkroman1/aai-runtime": patch
---

Test phone trees: eval sessions now carry sendDtmf presses (they answered "call
ended" on every press, so a phone-menu tool told a live model the call was over)
and report them as `turn.dtmf`; new `walkPhoneTree(session, tree)` plays an
automated menu declared as data and follows the keys the agent actually pressed.
The outbound-call-agent template gains phone-tree evals, a same-reply hang-up
rule, and a `scripts/phone-tree-call.mjs` harness that has a deployed agent dial
a real Twilio menu.
