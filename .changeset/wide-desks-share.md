---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
"@alexkroman1/aai-runtime": minor
"aai-templates": minor
---

The second half of the template audit: five families of code the templates kept rebuilding move into the SDK, and the templates become their worked examples.

**`@alexkroman1/aai-ui` — the session chrome kit.** `SessionStateDot`, `SessionControls` (with the headless `useSessionControls`), `ConversationView` (which `MessageList` is now built on, DOM unchanged), plus `AudioResult` and `WorkflowRunPanel` for workflow-app pages, and an `.aai-scroll` utility in `styles.css`. Three custom chromes (`dispatch-center`, `retail`, `infocom-adventure`) each rebuilt the dot, the Start/Pause/New/End row with the same twelve-line comment on `end()` vs `reset()`, and the conversation skeleton; two pages each rendered the audio block and the run panel by hand.

**`@alexkroman1/aai` — `sessionSlot({ caps })`.** A per-array growth cap the slot enforces after every write (after the author's `after` hook), typed so only array-valued keys are accepted (`SlotCaps<T>`). Ten templates paired a `MAX_*` constant with a wrapper whose whole body was `pushCapped`, and a wrapper caps only the paths that call it: `executive-assistant` had three uncapped arrays riding every `syncState` frame. `pushCapped` stays for nested lists.

**`@alexkroman1/aai/step` `mapSettled` / `partitionSettled` / `Settled`** — bounded fan-out with per-item failure isolated into a value, which `hiring-desk` and `briefing-desk` had composed over `mapConcurrent` and `Promise.allSettled`. **`@alexkroman1/aai/tts` `ttsVoiceIds(language?)`** — the `z.enum` tuple of catalog voices two templates derived by hand. **`spokenAlphanumeric`** beside `spokenDigits`.

**`@alexkroman1/aai/testing`** — `expectDeployable` (the three starter invariants six specs wrote out), `expectPromptBuiltinsDeclared` / `commandedBuiltins` (the prompt↔`builtinTools` scan two specs had byte-identically), `runGuardrail`, and `scriptedToolContext` (both model seams scripted, answering `{ ctx, model, desk }`).

**`@alexkroman1/aai-runtime/eval`** — `runCodeIn` / `runCodeOutput` (the second throws on the executor's refusal, importing the sentence from the executor rather than letting a spec re-type it), `expectToolBeforeSpeech`, and `EvalTurn.errors` with `errorsIn`.

Epochs: `aai:state` 18, `aai:testing` 29 and `aai-runtime:eval` 9 retain their predecessors with frozen examples; `aai:spoken`, `aai:step`, `aai:tts` and the three `aai-ui` capabilities are bumped with the additive-drop reason this repo records for a package that keeps no example of the superseded epoch.
