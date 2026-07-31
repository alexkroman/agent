---
"aai-studio-server": patch
---

Hard-budget the studio coding agent's model-controlled CPU work: `grep`'s
regex scan now runs inside a `vm.Script` with a 500ms hard timeout (V8
TerminateExecution interrupts catastrophic backtracking, which the
long-line skip never bounded and the per-tool pTimeout cannot stop — a
hostile pattern used to pin the server's event loop indefinitely), and
`edit_file`'s presentation diff passes jsdiff's `timeout` (500ms), eliding
the diff instead of stalling the process for seconds on large
mostly-different files. Glob compilation failures now surface as
actionable `StudioGrepError`s, and glob matching runs under the same scan
budget.
