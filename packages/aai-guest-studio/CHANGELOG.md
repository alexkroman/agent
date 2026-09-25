# aai-guest-studio

## 0.6.10

### Patch Changes

- Updated dependencies [b694949]
- Updated dependencies [fa9f694]
- Updated dependencies [b694949]
- Updated dependencies [c551022]
- Updated dependencies [b694949]
- Updated dependencies [b694949]
- Updated dependencies [04c4f49]
- Updated dependencies [fa9f694]
- Updated dependencies [feb93f7]
- Updated dependencies [7f6e8d6]
- Updated dependencies [7f6e8d6]
- Updated dependencies [c551022]
- Updated dependencies [1446ed4]
- Updated dependencies [fa9f694]
- Updated dependencies [c551022]
- Updated dependencies [c551022]
- Updated dependencies [b694949]
- Updated dependencies [c551022]
- Updated dependencies [b694949]
- Updated dependencies [e43664a]
- Updated dependencies [c551022]
  - @alexkroman1/aai@19.0.0
  - @alexkroman1/aai-runtime@19.0.0
  - @alexkroman1/aai-cli@19.0.0
  - @alexkroman1/aai-ui@19.0.0
  - aai-guest-core@0.6.9

## 0.6.9

### Patch Changes

- 21eb693: Fix four lifecycle bugs found auditing the SDK for hand-rolled state:
  
  - `runCapped` (the `bash` tool, npm, test and deploy children) now kills a timed-out command's whole process group, escalating SIGTERM to SIGKILL, and reports the deadline as `timedOut`. A command that trapped SIGTERM used to run past its deadline and read as a clean success, and one that backgrounded a job (`npm run dev &`) held the call open until that job exited.
  - `runFfmpeg`/`probeMedia` keep ffmpeg's stderr, exit code and signal on a `timeout` or `aborted` failure (they were always empty), and SIGKILL a child that ignores the abort.
  - A `dialog.tool()` whose dialog was moved by a sibling tool while its body was awaiting no longer applies its `send`/`sendFrom` from the state the sibling left it in.
  - Parts uploads keep one first-failure latch instead of two.
- Updated dependencies [b3e4ee5]
- Updated dependencies [fccb2ef]
- Updated dependencies [f02ee82]
- Updated dependencies [dc9d696]
- Updated dependencies [8cdc919]
- Updated dependencies [f4e7c87]
- Updated dependencies [7655482]
- Updated dependencies [4995fe6]
- Updated dependencies [f4e7c87]
- Updated dependencies [f4e7c87]
- Updated dependencies [75244f4]
- Updated dependencies [b324f33]
- Updated dependencies [b324f33]
- Updated dependencies [0338a93]
- Updated dependencies [6e051f8]
- Updated dependencies [f4e7c87]
- Updated dependencies [a6f3d59]
- Updated dependencies [3593ab7]
- Updated dependencies [21eb693]
- Updated dependencies [f4e7c87]
- Updated dependencies [b324f33]
- Updated dependencies [b324f33]
- Updated dependencies [695101f]
- Updated dependencies [651a8e9]
- Updated dependencies [b3e4ee5]
- Updated dependencies [113e88d]
- Updated dependencies [b3e4ee5]
  - @alexkroman1/aai-runtime@18.0.0
  - @alexkroman1/aai-cli@18.0.0
  - @alexkroman1/aai@18.0.0
  - @alexkroman1/aai-ui@18.0.0
  - aai-guest-core@0.6.8

## 0.6.8

### Patch Changes

- f5c64b5: Set the studio agent's output-token ceiling, and stop a truncated step failing silently.
  
  The coding agent kept stopping mid-build with nothing wrong on the server, and it worked before the AI SDK bump. **`ai@7.0.70` is where that changed.** `isToolExecutionAllowedFinishReason` now runs a step's tool calls only when the step finished `stop` or `tool-calls`; any other finish reason drops them unexecuted. No tool result means no continuation, so the turn ends — and from outside it is indistinguishable from the agent deciding it was done. Before that version the call still ran.
  
  The finish reason that reaches this in normal use is **`length`**: the step hit its output ceiling mid-tool-call. Which brings up the setting that was never made — **the studio agent set no `maxOutputTokens` at all**, and unset is not "no limit", it is whatever the gateway picks. A coding agent that writes a whole source file inside a tool-call argument is exactly the shape that reaches such a ceiling, and the two facts together turn a routine truncation into a turn that stops dead.
  
  So the ceiling is explicit now (32k, threaded host → session-init → `agent()` beside `maxSteps`). Sized against the JOB rather than the model — 32k tokens is ~128 KB, far more than any file written in one step — and deliberately NOT any model's true maximum, because the gateway serves a catalog (`STUDIO_LLM_MODELS`) whose smaller members would 400 on a value sized for the largest. `STUDIO_MAX_OUTPUT_TOKENS` overrides it, so tuning is a secret edit rather than a guest-image rebuild — which matters because the value is read on the server and spent inside the sandbox.
  
  **A bad override falls back rather than reaching the provider**, empty string included: the whole point of the setting is that an out-of-range ceiling truncates a step, and a truncated step now loses its tool calls, so handing the model call a `NaN` would cause the exact failure being fixed.
  
  **And the silent stop is named.** `onStepFinish` logs any finish reason outside `stop`/`tool-calls` with the number of tool calls discarded. A larger ceiling makes truncation rarer, not impossible, and the reason this took so long to find is that there was nothing in the log to find — the next occurrence is answerable from the server instead of inferred from a chat transcript.
  
  This does not replace the keep-going force added alongside it; that covers a model that chooses to stop, where this covers one that was cut off.
- Updated dependencies [f5c64b5]
  - aai-guest-core@0.6.7

## 0.6.7

### Patch Changes

- 42be20d: Stop the studio coding agent ending a turn mid-plan.
  
  The agent kept stopping with the work half done, and the only repair was to type "continue". The cause is the AI SDK's loop condition, not the model losing interest: the loop runs "until a finish reason other than tool-calls is returned", and **`stopWhen` can only ADD stop conditions — there is no condition meaning "keep going"**. So one step of prose is mechanically indistinguishable from the agent declaring itself finished.
  
  That is right for an answer and wrong for every other thing a model uses prose for. Reproduced with the repo's scripted-model harness: a turn with `maxSteps: 8`, the wall-clock budget barely touched and **three todos still pending** ended on a single narration of an obstacle — "the page is client-rendered, so I'll use the public menu" — and the next `todo_write` never ran. From the user's side the spinner just stops against a visibly half-marked plan.
  
  **The prompt was making it worse.** `studio-preamble.ts` told the model that ASKING ends the turn — true of all prose, not only questions — and then, two lines later, to "make the most reasonable assumption, say what you assumed, and continue". Said as its own step that instruction ENDS the turn, so the continuation it promises cannot happen; the advice was self-defeating exactly when the model hit something unexpected, which is when it was reached. There is now an "Ending Your Turn" section stating the real rule (a step with no tool call ends the turn, whatever is in it) and the way to comply: put the sentence in the SAME step as the next tool call.
  
  **The mechanism does not depend on the model reading that.** Since the turn is already over by the time a text-only step exists, there is nothing to react to after the fact — the stall has to be unrepresentable BEFORE the step runs. `turn-continue.ts` therefore returns `toolChoice: "required"` from `prepareStep` while the model's own last `todo_write` still shows outstanding items. It costs no expressiveness: text and a tool call in one step are still allowed, so the agent can narrate freely as long as it also keeps working — it just cannot narrate INSTEAD of working.
  
  Three independent releases, because a forced tool call must never be a trap. An empty plan never forces, so a one-step change or a question — which the preamble tells the model to run with no todo list at all — is untouched, and the force only engages once the model has itself declared multi-step work. `todo_write` is always a legal move, so marking the rest completed or cancelled drops the count to zero and the next step is free; the notice says so, because a constraint whose exit is invisible is one a model fights. And there is a cap (`MAX_FORCED_STEPS`, 25 against `MAX_CHAT_STEPS` of 80) plus a stand-down at the soft deadline, since the wrap-up notice asks for a spoken report and forcing a tool call would contradict it. Past all of those the runtime still guarantees a final answer: `forceFinalAnswer` composes LAST and owns `toolChoice` outright on the reserved step, so a forced turn cannot end mute.
  
  The per-step decision moved out of `chat.ts`'s `prepareStep` into `prepareTurnStep`. Three rules now write one key and their ORDER is the behaviour — the hard deadline takes tools away, the wrap-up must not be overridden by a force, and only inside both does the force apply — and as a branch chain in an HTTP handler that also does compaction, that ordering was the one part with no test. Both ordering specs deliberately stub `wrappingUp: false` against a fired deadline, a state the clock cannot produce: with the realistic `true` the stand-down suppresses the force by itself, and both tests passed with the branches reordered. A/B'd — reordering now fails three specs instead of one.
  
  `wrappingUp()` is a time predicate on the budget rather than a flag, so taking the wrap-up notice does not consume it and both readers get the same answer on the step where it matters.

## 0.6.6

### Patch Changes

- 350e80f: Split the guest into three packages. `aai-guest-core` holds the seven modules both guest modes need (`rpc`, `types`, `bundle`, `auth`, `http`, plus `trial` — the `run_code`/tool executor — and `limits`), `aai-guest-studio` holds the coding agent's 60 modules and the generated `studio-prompts/`, and `aai-guest` keeps the entry, agent mode, `toolchain/` and `dist/harness.mjs`.
  
  **Three, not two, and the shape is forced.** The entry dispatches studio mode while studio reaches back for the shared five at twenty call sites, so whichever package holds the entry must depend on studio — and studio then cannot depend on it. Two packages could only express that as a cycle, which for workspace packages is unbuildable. The entry has to stay in a package named `aai-guest` because `aai-server` resolves `aai-guest/harness` and bakes the tag into the guest snapshot image, so the shared modules are what moved. Their closure is exactly the modules that were shared, with no transitive pull-in, which is what made it worth doing. `StudioSession` moved into core with them: `bundle.ts` holds the studio-session slot, and a package that owns a slot owns the slot's type — declared in the studio package it was the one core→studio edge, enough to make the cycle real even though nothing behavioural crossed.
  
  `guest-core-package-boundary` and `guest-studio-package-boundary` are what keep the graph a DAG rather than leaving it one, and all eleven boundary deny-lists were regenerated from the tree rather than hand-edited for two new names — `konsistent-config.test.ts` derives the same matrix, and a deny list that goes stale does so by silence.
  
  Nothing changes for `aai-server` or the guest image beyond the tag: tsdown still bundles all three into one self-contained artifact. It is not byte-identical (16,203,601 bytes against 16,193,652 — 0.06% larger, from module ordering and the re-export shim), so the content-addressed image tag moves, exactly as it does for any harness edit.
  
  Five gate floors caught their own corpus shrinking, which is the part worth keeping: `guard-invariants` rule 12's guest scan (18 files against a minimum of 20), `check-deploy-changeset`'s per-package file floor, and the three coverage ratchets. Coverage needed the most care — it attributes a file to whoever LOADED it, so five `describe` blocks moved from `aai-guest/src/harness.test.ts` into core beside the modules they test, and each package's config excludes its siblings by name (`include: ["src/**"]` does not do it: a sibling's path ends in `src/` and matches the same glob). Without that, `aai-guest` measured all 60 studio modules and read 27% lines against a floor of 83. The three suites total 514 tests, exactly what the one package ran.
- Updated dependencies [f34290a]
- Updated dependencies [c129f05]
- Updated dependencies [49daf83]
- Updated dependencies [440e38a]
- Updated dependencies [0dcf247]
- Updated dependencies [440e38a]
- Updated dependencies [b7e21aa]
- Updated dependencies [599a749]
- Updated dependencies [440e38a]
- Updated dependencies [75f3ea5]
- Updated dependencies [4ab107e]
- Updated dependencies [180fd15]
- Updated dependencies [350e80f]
- Updated dependencies [07a046e]
- Updated dependencies [7832142]
- Updated dependencies [599a749]
- Updated dependencies [440e38a]
- Updated dependencies [599a749]
- Updated dependencies [180fd15]
- Updated dependencies [599a749]
- Updated dependencies [599a749]
- Updated dependencies [599a749]
- Updated dependencies [440e38a]
- Updated dependencies [0e12342]
- Updated dependencies [440e38a]
- Updated dependencies [482b874]
- Updated dependencies [f75ad5f]
- Updated dependencies [5ac5edb]
- Updated dependencies [440e38a]
- Updated dependencies [9c1fb03]
- Updated dependencies [9c1fb03]
- Updated dependencies [9c1fb03]
- Updated dependencies [49cebb8]
- Updated dependencies [7fe0571]
- Updated dependencies [350e80f]
  - @alexkroman1/aai@17.0.0
  - @alexkroman1/aai-runtime@17.0.0
  - @alexkroman1/aai-ui@17.0.0
  - @alexkroman1/aai-cli@17.0.0
  - aai-guest-core@0.6.6
