---
"@alexkroman1/aai-runtime": patch
---

The self-hosted journal's boot-sweep query reads the wait table once instead of once per candidate run. resumableRuns computed each run's earliest wake with a correlated subquery inside a CTE, which Postgres inlines - so the expression was re-planned as a fresh index scan at each of its three sites (filter, sort key, output). A grouped left join plus a hashed anti-join takes it from 349-375ms and 123,102 shared buffers to 24-28ms and 1,194, result-identical over the whole answer, verified with EXPLAIN ANALYZE against a real Postgres holding 50,000 runs. It matters because aai dev rebuilds its runtime on every file save and each rebuild is a boot sweep.
