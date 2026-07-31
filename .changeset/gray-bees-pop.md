---
"@alexkroman1/aai": patch
"aai-server": patch
---

Replace hand-rolled patterns with newer Node built-ins: util.styleText instead of picocolors in the CLI (dependency removed), one-shot crypto.hash() for SHA-256 digests, node:timers/promises for the dev-server listen retry, and an async-disposable WarmHarness (Symbol.asyncDispose + await using) that unifies the sandbox teardown triple across describeBundle, configureSandbox failure paths, and the studio sandbox.
