---
"@alexkroman1/aai": patch
---

Make the bundle/runtime boundary explicit: every key two copies of the SDK meet on (the clientTool, routeResponse, routeError, step-error and keyless-synthesizer brands, and every globalThis slot a host publishes) is registered in one module and reached by name, and a gate refuses a Symbol.for or a hand-spelled key anywhere else. The clientTool and step-error brand keys are now prefixed @alexkroman1/aai like the rest, so a bundle and the host running it must be built from this version or later.
