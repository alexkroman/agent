---
"aai-server": patch
---

Record, in workflow-queue-claim.ts, the measured cost curve of the queue claim and the rewrite that flattens it. The claim re-orders the whole due set before its limit, so DB work per message delivered grows linearly with the backlog: 2.7ms at 1,000 due against 475ms and 13.3MB of temp at 180,000, where it sorts 179,960 rows to return 8. A three-part rewrite (distinct-on to a group-minimum anti-join, splitting the locked_at OR so the unclaimed branch is an ordered index scan, and pushing the outer limit into each arm) is result-identical and 8.6x faster at 20,000 due, but needs an index costing +22/35/20% on enqueue/claim/ack and 30MB. Comment only: the numbers are recorded so the cost-model decision is cheap, not so it is made.
