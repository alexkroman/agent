# aai-guest-core

## 0.6.7

### Patch Changes

- f5c64b5: Set the studio agent's output-token ceiling, and stop a truncated step failing silently.
  
  The coding agent kept stopping mid-build with nothing wrong on the server, and it worked before the AI SDK bump. **`ai@7.0.70` is where that changed.** `isToolExecutionAllowedFinishReason` now runs a step's tool calls only when the step finished `stop` or `tool-calls`; any other finish reason drops them unexecuted. No tool result means no continuation, so the turn ends — and from outside it is indistinguishable from the agent deciding it was done. Before that version the call still ran.
  
  The finish reason that reaches this in normal use is **`length`**: the step hit its output ceiling mid-tool-call. Which brings up the setting that was never made — **the studio agent set no `maxOutputTokens` at all**, and unset is not "no limit", it is whatever the gateway picks. A coding agent that writes a whole source file inside a tool-call argument is exactly the shape that reaches such a ceiling, and the two facts together turn a routine truncation into a turn that stops dead.
  
  So the ceiling is explicit now (32k, threaded host → session-init → `agent()` beside `maxSteps`). Sized against the JOB rather than the model — 32k tokens is ~128 KB, far more than any file written in one step — and deliberately NOT any model's true maximum, because the gateway serves a catalog (`STUDIO_LLM_MODELS`) whose smaller members would 400 on a value sized for the largest. `STUDIO_MAX_OUTPUT_TOKENS` overrides it, so tuning is a secret edit rather than a guest-image rebuild — which matters because the value is read on the server and spent inside the sandbox.
  
  **A bad override falls back rather than reaching the provider**, empty string included: the whole point of the setting is that an out-of-range ceiling truncates a step, and a truncated step now loses its tool calls, so handing the model call a `NaN` would cause the exact failure being fixed.
  
  **And the silent stop is named.** `onStepFinish` logs any finish reason outside `stop`/`tool-calls` with the number of tool calls discarded. A larger ceiling makes truncation rarer, not impossible, and the reason this took so long to find is that there was nothing in the log to find — the next occurrence is answerable from the server instead of inferred from a chat transcript.
  
  This does not replace the keep-going force added alongside it; that covers a model that chooses to stop, where this covers one that was cut off.

## 0.6.6

### Patch Changes

- 350e80f: Split the guest into three packages. `aai-guest-core` holds the seven modules both guest modes need (`rpc`, `types`, `bundle`, `auth`, `http`, plus `trial` — the `run_code`/tool executor — and `limits`), `aai-guest-studio` holds the coding agent's 60 modules and the generated `studio-prompts/`, and `aai-guest` keeps the entry, agent mode, `toolchain/` and `dist/harness.mjs`.
  
  **Three, not two, and the shape is forced.** The entry dispatches studio mode while studio reaches back for the shared five at twenty call sites, so whichever package holds the entry must depend on studio — and studio then cannot depend on it. Two packages could only express that as a cycle, which for workspace packages is unbuildable. The entry has to stay in a package named `aai-guest` because `aai-server` resolves `aai-guest/harness` and bakes the tag into the guest snapshot image, so the shared modules are what moved. Their closure is exactly the modules that were shared, with no transitive pull-in, which is what made it worth doing. `StudioSession` moved into core with them: `bundle.ts` holds the studio-session slot, and a package that owns a slot owns the slot's type — declared in the studio package it was the one core→studio edge, enough to make the cycle real even though nothing behavioural crossed.
  
  `guest-core-package-boundary` and `guest-studio-package-boundary` are what keep the graph a DAG rather than leaving it one, and all eleven boundary deny-lists were regenerated from the tree rather than hand-edited for two new names — `konsistent-config.test.ts` derives the same matrix, and a deny list that goes stale does so by silence.
  
  Nothing changes for `aai-server` or the guest image beyond the tag: tsdown still bundles all three into one self-contained artifact. It is not byte-identical (16,203,601 bytes against 16,193,652 — 0.06% larger, from module ordering and the re-export shim), so the content-addressed image tag moves, exactly as it does for any harness edit.
  
  Five gate floors caught their own corpus shrinking, which is the part worth keeping: `guard-invariants` rule 12's guest scan (18 files against a minimum of 20), `check-deploy-changeset`'s per-package file floor, and the three coverage ratchets. Coverage needed the most care — it attributes a file to whoever LOADED it, so five `describe` blocks moved from `aai-guest/src/harness.test.ts` into core beside the modules they test, and each package's config excludes its siblings by name (`include: ["src/**"]` does not do it: a sibling's path ends in `src/` and matches the same glob). Without that, `aai-guest` measured all 60 studio modules and read 27% lines against a floor of 83. The three suites total 514 tests, exactly what the one package ran.
- Updated dependencies [f34290a]
- Updated dependencies [c129f05]
- Updated dependencies [440e38a]
- Updated dependencies [0dcf247]
- Updated dependencies [b7e21aa]
- Updated dependencies [599a749]
- Updated dependencies [4ab107e]
- Updated dependencies [180fd15]
- Updated dependencies [07a046e]
- Updated dependencies [7832142]
- Updated dependencies [599a749]
- Updated dependencies [599a749]
- Updated dependencies [180fd15]
- Updated dependencies [599a749]
- Updated dependencies [599a749]
- Updated dependencies [599a749]
- Updated dependencies [440e38a]
- Updated dependencies [440e38a]
- Updated dependencies [482b874]
- Updated dependencies [f75ad5f]
- Updated dependencies [440e38a]
- Updated dependencies [9c1fb03]
- Updated dependencies [9c1fb03]
- Updated dependencies [9c1fb03]
- Updated dependencies [49cebb8]
- Updated dependencies [7fe0571]
- Updated dependencies [350e80f]
  - @alexkroman1/aai@17.0.0
  - @alexkroman1/aai-runtime@17.0.0
