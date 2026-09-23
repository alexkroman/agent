---
"@alexkroman1/aai": patch
"aai-guest-studio": patch
"aai-server": patch
---

Fix four lifecycle bugs found auditing the SDK for hand-rolled state:

- `runCapped` (the `bash` tool, npm, test and deploy children) now kills a timed-out command's whole process group, escalating SIGTERM to SIGKILL, and reports the deadline as `timedOut`. A command that trapped SIGTERM used to run past its deadline and read as a clean success, and one that backgrounded a job (`npm run dev &`) held the call open until that job exited.
- `runFfmpeg`/`probeMedia` keep ffmpeg's stderr, exit code and signal on a `timeout` or `aborted` failure (they were always empty), and SIGKILL a child that ignores the abort.
- A `dialog.tool()` whose dialog was moved by a sibling tool while its body was awaiting no longer applies its `send`/`sendFrom` from the state the sibling left it in.
- Parts uploads keep one first-failure latch instead of two.
