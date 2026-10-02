---
"@alexkroman1/aai": patch
---

`defineAgentTestConfig()` now sets `restoreMocks`, `unstubEnvs` and
`unstubGlobals`, so a scaffolded project's specs no longer leak a `vi.spyOn`,
`vi.stubEnv` or `vi.stubGlobal` into the next test. Pass
`test: { unstubGlobals: false }` (or any of the three) to opt out.
