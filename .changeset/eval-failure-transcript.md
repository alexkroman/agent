---
"@alexkroman1/aai-runtime": minor
---

Every eval failure `describeEval` reports now carries the failing try's transcript under the assertion — each line said, each reply, each tool call with its arguments and result, and any request the eval network refused — not only an UNSTABLE case in the `AAI_EVAL_REPEAT` summary. The same view is exported as `transcriptOf(session, network?)` from `@alexkroman1/aai-runtime/eval`. A refused request a builtin retried is listed once, with a count.
