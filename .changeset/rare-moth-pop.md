---
"@alexkroman1/aai-cli": patch
---

aai dev no longer breaks JSON mode's one-result-line stdout contract: the SDK's default logger is console-backed and console.log is stdout, so the runtime's own diagnostics (the multi-line Session mode resolved dump at startup, every later warning) landed above the single JSON line. JSON mode is auto-detected on a pipe, so that was the normal case — aai dev > dev.log, a process supervisor, a container. The runtime now logs through a logger the command chooses, which writes to stderr with its structured context intact once output is silenced; human mode keeps the console logger untouched.
