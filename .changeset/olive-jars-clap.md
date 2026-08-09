---
"@alexkroman1/aai": minor
---

Close four places where the SDK's types contradicted its own runtime.

- **`sttPrompt` is now declarable on an S2S agent.** The transport has forwarded
  it as `input.transcription_prompt` since the S2S dropped-field fix, and
  `AgentDef.sttPrompt` documents it as honoured in both modes, but
  `PipelineOnlyField` still listed it — so `agent({ s2s, sttPrompt })` was a
  compile error naming a rule that was no longer true, and the measured win (a
  spelled first name going from 1 of 6 attempts correct to 6 of 6) was reachable
  only by skipping `agent()` for a raw config object. Purely widening; no
  existing agent changes behaviour.

- **`ctx.generate({ schema })` now types `object` as required.** The host runs
  `generateObject` and returns `{ text, object }` unconditionally on that path,
  but the optionality survived the typed overload, so the one spelling the
  overload exists to reward needed a `!` or an `if` before any field could be
  read. `GenerateResult` is now text-only (with `object?: unknown` for plain
  JSON Schema calls) and a Standard Schema call returns the new
  `GenerateObjectResult<T>`.

- **`ctx.signal` is now non-optional.** The executor builds a per-call
  `AbortController` on every path and no context has ever lacked one, so the `?`
  only bought a `?.` on every `ctx.signal.aborted`. Contexts that genuinely
  cannot cancel supply a signal that never aborts. **Migration:** code that
  hand-builds a `ToolContext` (test mocks, almost exclusively) must add
  `signal: new AbortController().signal`; consuming `ctx.signal` needs no change.

- **`assemblyAIS2s()` takes `{ voice, languages, keyterms }`.** It previously
  took no options at all, so an AssemblyAI S2S agent could not pick its voice
  and could not reach `input.language_codes` or `input.keyterms` — the pipeline
  had all three. Each is forwarded only when set; leaving `languages` unset
  still means "detect per turn", and a malformed stored value is dropped rather
  than put on the wire. The accepted voice set is the service's and is not
  verified here — an id it rejects arrives in-band after connect, leaving an
  agent that reports ready and never speaks.
