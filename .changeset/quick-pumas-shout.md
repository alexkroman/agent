---
"@alexkroman1/aai-runtime": patch
"aai-server": patch
---

Open a workflow delivery in ONE platform round trip, and place guest sandboxes where the platform database is.

`execute` awaited `journal.getRun(runId)` and only then issued the step read, the wait read and the `running` compare-and-set — so every delivery paid two sequential round trips (~840 ms each on the platform arm) before a body could run. Nothing in that opening depends on the record: the three reads are pure functions of the run id and the set carries its own `expect`, so all four are now issued together. A set that loses is re-asked rather than believed — issued beside the record read it can reach the store ahead of a racing `start`'s `createRun` and decline a run that exists a moment later.

`modal_deploy.py` also exports its own `REGIONS` list as `MODAL_SANDBOX_REGION`, so guests are placed in the platform's region instead of wherever Modal finds capacity: a durable run's journal calls are made by the guest, sequentially, at ~24 ms an operation out of region against ~2 ms in it. It is the LIST rather than a single region — a bare pin is what once made a spawn Modal could not schedule fail the session with `Sandbox operation timed out`.
