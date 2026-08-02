---
"aai-guest": patch
---

Run the studio's test_agent workspace build in a one-shot child process. Rolldown allocates outside V8 and never returns that memory to the OS, so an in-process build left ~1.5 GB permanently resident in the long-lived guest harness — measured 258 MB to 1.7 GB on one build, climbing with each later one. Publish already spawned the CLI; both build paths now exit to reclaim.
