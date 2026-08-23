---
"@alexkroman1/aai": minor
---

Authoring-surface fixes found by manually testing the SDK.

**Wrong or unsafe**

- `multipartBody` escapes a part's `name` and `filename`. An uploader-supplied
  filename (`uploadInfo().name`, which `stepTranscribeSync` forwards) could
  close the quoted header value and append headers of its own to a step's
  request.
- An AssemblyAI TTS `language` the declared voice cannot speak is now a config
  error naming the voices that can, instead of an agent that connects, reports
  ready and never speaks. Includes the pair the SDK built itself:
  `assemblyAITts({ language: "fr" })` filled in the English default voice. A
  voice this release's catalog does not list is still passed through — and
  `aai build`/`aai dev` now WARN about it (`agentConfigWarnings`), since
  refusing one would refuse a voice AssemblyAI shipped after this release while
  saying nothing left a typo to surface as a silent agent. A deprecated voice
  gets its own line.
- `pcmDurationMs` refuses a `Uint8Array` where a byte count goes rather than
  answering `NaN`, and names itself instead of `encodeWav` in the format check
  the two share.

**Silent**

- Every `ctx.send` drop is logged. The two wire caps — an over-long event name
  and an over-64 KB payload — returned silently while `ToolContext.send`
  documented "dropped (with a warning log)".
- `createToolContext()`'s `send` applies that same rule, so `ctx.sent` records
  what the client would receive. It used to record events production throws
  away, passing a spec for a notification nobody ever got.
- Two `sessionSlot`s on one key that disagree about the shape they store are
  refused per session, instead of silently reading and writing each other's
  value. Two declarations that AGREE still share a key, which is how `dialog()`
  works.
- `aai build` and `aai dev` warn when a `"use workflow"` body calls `Date.now()`,
  `new Date()`, `Math.random()`, `crypto.randomUUID()` or `fetch()` — each
  replays differently on every resume. Step bodies are exempt by construction.
- A builtin made inert by a `tools/` file of the same name is logged. The file
  still wins.

**Reported as a sentence**

- A config-shape mistake (`agent({ maxSteps: 0 })`, a bad `builtinTools` entry)
  reached the author as a raw dump of zod issue objects at `aai build`.
  `toAgentConfig` now throws one line naming each bad field, and `errorMessage`
  renders any validation error's issues rather than its JSON-dump `message`.
- `toolOf`/`runTool` say what they were handed when it is a tool def or
  `undefined`, instead of `Cannot read properties of undefined`.
- `dialog(spec)` — the one-object shape every other authoring function takes —
  names the signature instead of dying on an `in` check, and a `dialog()` whose
  `initial` names no declared state is refused rather than silently stuck.

**Refused earlier**

- `agent({ silencePrompt })` with no `silenceTimeoutMs` is a compile error; it
  was a config error at build time.
- `agent({ tools })` reports the file-is-a-tool rule on every arm. On a voice
  agent tsc used to print the workflow-app message first.
- A `tools/` file whose name is longer than a provider accepts (64), and a
  `tools/index.ts` barrel, are named at build instead of failing at the first
  turn or reaching the model as a tool called `index`.
- A blank agent `name`, and a `requiredEnv` entry no environment could hold, are
  rejected.
