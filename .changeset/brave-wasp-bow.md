---
"@alexkroman1/aai-cli": patch
---

Fix the scaffold's SIGINT/SIGTERM handler crashing on shutdown. `server.mjs` registered an `async` listener with `process.once`, and `process` discards what a listener returns — so a `server.close()` that rejected became an unhandled rejection, i.e. a stack trace and a nonzero exit on Ctrl-C instead of the clean shutdown the handler exists for. The listener is synchronous now and reports a failed shutdown on its own. Every project `aai init` created carries the old handler; `biome.json` excludes `**/scaffold`, so no linter could have caught it.
