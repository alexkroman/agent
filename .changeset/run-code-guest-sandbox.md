---
"@alexkroman1/aai": patch
---

Security: the `run_code` builtin no longer executes on the host via `node:vm`.
`node:vm` is not a security boundary — its wrappers still exposed the host
`Function` constructor through the prototype chain, allowing a
`console.log.__proto__.constructor("return process")()` escape to the host
process (env/secrets + RCE). `run_code` now runs only inside the guest sandbox
(gVisor/Deno), where the OS-level isolation is the real boundary. The host-side
`executeInIsolate` helper is removed from the `@alexkroman1/aai/runtime` export.
In the self-hosted path (`aai dev`), which has no sandbox, `run_code` returns an
error instead of evaluating code on the host.
