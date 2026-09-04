# @alexkroman1/aai-ui

## 15.0.0

### Minor Changes

- 29fbf01: aai-ui: publish the three behaviour rules the studio front-end had duplicated. `useFlash` and `useCopy` replace three hand-rolled flashes — including the one inside the URL chips, which swallowed a refused clipboard write so the button did nothing visible; a refusal now reports `Failed`. `fieldKindFor` is `<WorkflowFields>`'s own control-selection rule, extracted out of `SchemaField` so there is one decision and published so a reader documenting the form-to-JSON correspondence asks it rather than mirroring the switch. The studio's chat transcript and Logs pane also drop `use-stick-to-bottom` for `<AutoScroll>`, this package's one owner of that effect.

### Patch Changes

- Updated dependencies [f9c1a98]
- Updated dependencies [8dc4cbb]
  - @alexkroman1/aai@15.0.0

## 14.0.0

### Major Changes

- 292ae33: useToolResult defaults its result to `unknown` rather than `any`, and useToolCallStart takes a type parameter for the tool's args. The result type is inferred at `tool()` and this hook is the one place a client reads it, so an `any` default discarded the inference exactly where it was wanted; the start hook had no type parameter at all, so args could not be checked even by a client that knew the shape.

### Minor Changes

- 79e3ea6: Publish seven more seams the templates had each re-derived: `formatMoney` (`@alexkroman1/aai/utils`), `ffmpegBaseArgs` (`/ffmpeg`), `routeStepFetch` (`/testing`), and `Session.restart()`, `WorkflowSubmission.startedHere`, `<BulletList>` and `<Facts>` (`@alexkroman1/aai-ui`).
  
  Two are behaviour fixes rather than de-duplication. `Controls`' "New Conversation" button called `reset()`, which reconnects carrying the same session id — so on any agent with a `sessionSlot` the caller got a blank transcript in front of their old state; it calls `restart()` now. And `transcodeToWav` did not pass `-nostats`, so ffmpeg's progress output could evict the error explaining a failure out of the captured stderr tail.
  
  `startedHere` is the fact only the hook can know — six pages kept a `useState(false)` beside it, set in their own `onSubmit` and mirrored in their `onClear`, to tell a run this page started from one the mount-time lookup adopted after a reload.
  
  The published stylesheet now honours `prefers-reduced-motion: reduce`, which appeared nowhere in the repository before: roughly nineteen infinite animations ship in an aai app, and the universal selector is the only thing that reaches the keyframes a template declares in its own `<style>` block.
- 79e3ea6: Publish the four seams a custom chrome kept rebuilding.
  
  `useSessionActions()` is `useSessionCore` narrowed to the eight control methods, with no snapshot subscription. `<Controls>` and `<StartScreen>` pair a one-field selector with the core; a template could not, so four components across three templates held a WHOLE-SNAPSHOT `useSession()` purely to reach `start`/`toggle` — and the snapshot object is rebuilt on every change, so those rows re-rendered on every STT partial. `Session` is now `SessionSnapshot & SessionActions`, so the member list is one list.
  
  `useSessionStatus()` / `useSessionError()` are the only two snapshot fields more than one chrome ever selects, written inline eight times — including in `ConsoleShell`'s own `@example`, which taught the inline form. Their selectors are module scope, because `useSyncExternalStoreWithSelector` keys its selection memo on the selector.
  
  `<SessionErrorBanner>` is the announced `role="alert"` banner without the frame around it, composed into `ConsoleShell` (which therefore no longer takes an `error` prop — the one breaking edge here, and the migration is to delete that prop, since the shell renders the banner itself) so a full-bleed chrome can take the announced-error decision on its own. The three hand-rolled copies had already drifted, one of them dropping `error.code`.
  
  `AGENT_STATE_LABELS` is the `Record<AgentState, string>` four pages spelled as a ternary chain, so a new state is a compile error rather than a silent fall-through to whichever word each chain ended on.
  
  The three custom chromes that had each rebuilt these — `retail`, `dispatch-center` and `infocom-adventure` — now take them: no whole-snapshot `useSession()` left in any of the three, and `infocom-adventure`'s banner reports the error code it had dropped.

### Patch Changes

- a1a4e1e: Refresh the aai-ui README as an end-to-end UI integration walkthrough: one labelled file per step (agent, tool, tool-result component, client), a compiling workflow-app example, and a corrected export tour.
- 79e3ea6: Cut duplication and wasted render work in the browser client: one guarded web-storage helper behind the three stores, a shared submission scaffold for the two workflow form hooks, coalesced upload progress reports, and lazy tool-call result formatting.
- Updated dependencies [b5beca2]
- Updated dependencies [79e3ea6]
- Updated dependencies [a9c1577]
- Updated dependencies [292ae33]
- Updated dependencies [292ae33]
- Updated dependencies [79e3ea6]
- Updated dependencies [292ae33]
- Updated dependencies [a9c1577]
- Updated dependencies [ef096bb]
  - @alexkroman1/aai@14.0.0

## 13.3.0

### Minor Changes

- 25e42e8: useWorkflowSubmit now remembers a run and picks it back up by default: it mints an opaque per-page correlation key into sessionStorage, records every run under it, and adopts that key's newest run on mount, so a reload lands back on the same result, progress log and controls instead of an empty form beside a live run nothing can name. Six of six page templates passed useRunKey() and recover: true to get this, and they now pass neither. A page that wants a different scope still passes key (an account's id, or useRunKey({ storage: "local" })), and recover: false opts the lookup out.

### Patch Changes

- @alexkroman1/aai@13.3.0

## 13.2.0

### Patch Changes

- Updated dependencies [4fb6b05]
  - @alexkroman1/aai@13.2.0

## 13.1.0

### Patch Changes

- @alexkroman1/aai@13.1.0

## 13.0.0

### Patch Changes

- Updated dependencies [9e12bb2]
- Updated dependencies [9e12bb2]
- Updated dependencies [9584e2e]
- Updated dependencies [9584e2e]
  - @alexkroman1/aai@13.0.0

## 12.0.0

### Patch Changes

- @alexkroman1/aai@12.0.0

## 11.0.0

### Patch Changes

- Updated dependencies [36a3f22]
- Updated dependencies [0718b57]
- Updated dependencies [fe3b6d6]
- Updated dependencies [63e1c8e]
- Updated dependencies [36a3f22]
- Updated dependencies [f10b6aa]
- Updated dependencies [7ab47cf]
- Updated dependencies [31459e8]
  - @alexkroman1/aai@11.0.0

## 10.0.1

### Patch Changes

- @alexkroman1/aai@10.0.1

## 10.0.0

### Minor Changes

- dd699c7: Add `useRunKey()`: the opaque, storage-backed lookup key `useWorkflowSubmit({ key, recover: true })` needs, with the storage kind (`session`, the default, or `local`) left to the caller. Six templates had each minted their own; the key is now scoped to the page's URL, so two agents scaffolded from one template on a shared origin no longer recover each other's runs.

### Patch Changes

- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
  - @alexkroman1/aai@10.0.0

## 9.2.0

### Patch Changes

- Updated dependencies [1ad4977]
- Updated dependencies [bee46bc]
  - @alexkroman1/aai@9.2.0

## 9.1.0

### Patch Changes

- Updated dependencies [041a5a2]
  - @alexkroman1/aai@9.1.0

## 9.0.2

### Patch Changes

- @alexkroman1/aai@9.0.2

## 9.0.1

### Patch Changes

- @alexkroman1/aai@9.0.1

## 9.0.0

### Major Changes

- 444e209: The workflow hooks take the workflow DEFINITION as their type parameter, not its output type — which types `submit(input)` as well. Migration is one token per call site: `useWorkflowSubmit<Digest>("digest")` becomes `useWorkflowSubmit<typeof digest>("digest")`. `submitForm` is the door for a `<Form>`'s DOM-scraped values.

### Minor Changes

- 444e209: Name what `submit()` takes. `SubmitInputOf<D>` and `WorkflowInputOf` are on the barrel: the first is in both submit hooks' return type and had nowhere to click, the second was the missing half of a pair whose `WorkflowOutputOf` was already re-exported here — so a page typing a form value reached past this package for one name. `SubmitOutputOf` came off in the same change; it was `WorkflowOutputOf` spelled a second way.

### Patch Changes

- af284a7: Stop reconnecting after a fatal session error, so the server's message reaches the page immediately.
- 044236f: Make a deployed agent's session state durable, and stop reporting an absent run as a server error. The runtime read the platform pair (`AAI_PUBLIC_BASE_URL`/`AAI_GUEST_TOKEN`) out of the AGENT's env, where the platform never puts it, so every deployed agent fell back to the memory backend and a session did not survive its sandbox restarting; uploads fell back to local for the same reason. A 404 from platform run storage now becomes the DevKit's own `WorkflowRunNotFoundError`, so GET/DELETE/wake on an unknown run answer 404/`cancelled:false`/`woken:0` instead of 500. The browser client reports a refusal close's own reason instead of discarding it, and a dev-mode `aai init` pins the third-party deps it shares with the linked workspace so two copies of xstate cannot fail the typecheck gate.
- Updated dependencies [444e209]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [e888216]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [f6be741]
- Updated dependencies [af284a7]
- Updated dependencies [e20a992]
- Updated dependencies [444e209]
- Updated dependencies [841f460]
- Updated dependencies [b238ba0]
- Updated dependencies [6796ae3]
- Updated dependencies [5bac92d]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
  - @alexkroman1/aai@9.0.0

## 8.2.1

### Patch Changes

- @alexkroman1/aai@8.2.1

## 8.2.0

### Patch Changes

- @alexkroman1/aai@8.2.0

## 8.1.0

### Patch Changes

- Updated dependencies [2f899e1]
- Updated dependencies [1789a55]
  - @alexkroman1/aai@8.1.0

## 8.0.0

### Major Changes

- c0e3d85: Move four aai-ui tuning constants to @alexkroman1/aai-ui/internal, restore noImplicitAny in the scaffold, and teach the classified step call as the default. TRANSCRIBING_PLACEHOLDER, DEFAULT_PROGRESS_POLL_MS, DEFAULT_WORKFLOW_POLL_MS and MAX_MISSING_READS are no longer exported from the package root: no public signature named one and the hooks that own the intervals take them as options. Scaffolded projects now run strict with noImplicitAny ON, which restores evolving-array and evolving-let inference.

### Patch Changes

- Updated dependencies [83edc89]
- Updated dependencies [1d58f53]
- Updated dependencies [6960bfa]
- Updated dependencies [efa6152]
- Updated dependencies [01b790c]
- Updated dependencies [56b775c]
  - @alexkroman1/aai@8.0.0

## 7.0.0

### Major Changes

- d98169a: **Breaking (nominally): `@alexkroman1/aai-ui/default-client/*` is removed.** It
  had no consumer in any form — not one import specifier in the repo, the
  templates, the scaffold, or any README — because every real consumer reaches
  those files by filesystem path through `./package.json` (`client-dir.ts`,
  `aai-server/transport-websocket.ts`). `files: ["dist"]` still ships them, so
  nothing that worked stops working. `aai-studio-client`'s `./dist/*` goes for the
  same reason: both of its consumers `require.resolve` the manifest and join
  `"dist"` themselves.
  
  Also widens `check:attw`. `aai-ui` pinned `--entrypoints .`, which silently
  excluded `./client-dir` — a typed, contracted subpath — and `aai-runtime`
  inherited the same pin. `aai-ui` now uses `--exclude-entrypoints styles.css`
  (a CSS entry point has no type declarations, which is the only reason the pin
  existed) and `aai-runtime` drops it entirely, so a NEW subpath defaults into
  being checked instead of out.
- abfc018: Say the duplicated types once, and stop the config union refusing what
  `client()` can render.
  
  `WorkflowStreamSubmission<R>` was `WorkflowSubmission<R>` character for
  character — eight fields, identical types, differing only in prose — and
  `UseWorkflowStreamOptions` restated `Omit<UseWorkflowSubmitOptions, "wait">` the
  same way. Both are aliases now. The property the copies existed to describe is
  that the two hooks are drop-in siblings, and a copy is exactly the thing that
  cannot hold it: `contracts/compatibility/workflow/v9.tsx` asserted the result
  half by hand ("if these two return types ever diverge, this function stops
  compiling — which is the assertion"), which is a test that the copying was done
  correctly rather than a reason not to copy. The stream-specific prose moved onto
  the aliases, and epoch 13's example adds the options half, which the copy could
  never guarantee.
  
  `ClientConfig` is one flat type instead of a union of `ConfigTier` and
  `ComponentTier` over a shared `BaseOptions`, and the three are no longer
  exported. The union existed only to express "`component` and `sidebar` are
  mutually exclusive", spelled with `?: never` — and that shape had already
  backfired twice, both recorded in `define-client.tsx`: `client({ name,
  component })` and `client({ component, tools })` are the natural things to
  write, both were refused with *"Type 'string' is not assignable to type
  'undefined'"*, and both bans were lifted after costing build rounds. What was
  left banned was `sidebar` beside a `component`, inviting the identical failure
  for a combination `client()` can simply render — so it renders it, wrapping the
  custom component in the same `SidebarLayout` the default shell uses. `sidebar`
  beside a `component` was silently dropped before; now it is a pane.
  
  `VOICE_CAPTURE_CONSTRAINTS` moves to `@alexkroman1/aai-ui/internal`. It is a
  framework decision with no `client()` field to set — the same category as the
  audio budgets `types.ts` already re-exports from the SDK's own `/internal` —
  and no `client.tsx` in the tree ever named it. A chrome that bypasses
  `client()` and opens its own microphone reaches it there, beside the providers
  it also needs.
  
  `aai-ui:session` also gained the guard it was missing. The capability froze
  `useUserTranscript` and the headless `createSessionCore` path, which has no
  real consumers, and left out `useSession` — the third-most-used session export
  across the templates. Epoch 4's example renders from it: the snapshot, the
  controls, and `AgentState` in the `satisfies Record<AgentState, string>` idiom
  three templates use.
- 76ca287: **BREAKING — the last 76 `@internal` names come off the two packages' public
  barrels: 68 to `@alexkroman1/aai-runtime/internal`, 8 to a new
  `@alexkroman1/aai-ui/internal`.** Both `contracts/internal-surface.json`
  ratchets are now at zero, which is where `@alexkroman1/aai` already stood.
  
  The exemption those files record is the one hole in the capability contracts: a
  name tagged `@internal` at its declaration site but reachable anyway from a
  public subpath belongs to no capability, gets no epoch and no frozen compiling
  template, and is held to nothing but a comment. It is a ratchet that may shrink
  and may never grow, and counting it is what got it paid off — `aai` went 71 to
  0, `aai-runtime` 68 to 0, `aai-ui` 8 to 0.
  
  A release tag cannot close it from the barrel. API Extractor reads `@internal`
  at the DECLARATION site, so the tag on a re-export clause member is silently
  ignored and the name stays `@public` in the report. A deny-listed subpath is the
  mechanism, and it is the third time this repo has reached for it.
  
  **`@alexkroman1/aai-runtime`** — the second tranche off that root barrel, after
  the 31 host-internal pass-throughs that made the subpath exist. These 68 are the
  package's OWN host infrastructure: the host-mode server and its tool relay, both
  transports and the `Transport` contract they satisfy, the session core, the
  session-state backends and the table names and DDL they own, the workflow
  serving half (API handler, surface, world, install), the wake hint, the
  queue-lock sweep, the step-slot publishers, and the two shipped `Logger` values.
  What stays on the root barrel is exactly what a capability covers.
  
  Where a type is contracted and its constructor is not, the two now split: the
  `SessionCore`, `SessionStateBackend`, `SessionStateStore`, `SessionEventPage`,
  `SessionEventStream`, `Logger` and `S2SConfig` TYPES — the shapes a host
  implementing one has to name — stay on the root barrel; `createSessionCore`,
  `createMemoryStateBackend`, `createSessionStateStore`, `createSessionEventStream`
  and `consoleLogger` move. The 17-name OPENER CONTRACT deliberately did not move,
  for the reason it did not move last time: relocating it would make a custom
  speech provider import from two subpaths, one labelled not-semver-covered.
  
  **`@alexkroman1/aai-ui`** gains its first `./internal` subpath, carrying
  `SessionProvider`, `ThemeProvider`, `ToolConfigContext`, the three URL chips
  (`ApiUrlChip`, `SessionUrlChips`, `UiUrlChip`), `buildAgentUrl` and
  `loadClientConfig` — none of which a `client.tsx` names, and all of which sat in
  a client author's autocomplete beside `client()` and `useAgentState`.
  
  `aai-server`, `aai-guest`, `aai-cli`, `aai-evals` and `aai-studio-server` import
  the moved names from the new subpaths — the cross-package consumers the seam
  exists for.
  
  Both barrels now state the rule in their module docs, so the next name does not
  re-open the ratchet: a name on `/internal` that wants to become public gets its
  `@internal` tag REMOVED at the declaration site and joins a capability under
  `contracts/entrypoints/`, which is what buys it an epoch. It is never
  re-exported from the public barrel with the tag still on it.
- 23e8b3f: **Breaking: `SessionCoreOptions` is removed.** It was an exact alias of
  `VoiceSessionOptions` with a single referent — `createSessionCore`'s parameter,
  which now names `VoiceSessionOptions` directly — and `client()` never took it.
  Replace `SessionCoreOptions` with `VoiceSessionOptions`; nothing else changes.
  
  `fetchClientConfig` is now public and part of the `page` capability. A workflow
  app mounted with `page()` makes no `GET client-config` request of its own, so
  this is how a page reads the agent's declared `name` and `greeting` — which two
  published doc comments already told authors to do while the function was
  `@internal` and absent from the reference.
  
  `SubmitButton` accepts `variant` and every `<button>` attribute except `type`
  and `disabled` (which it owns, setting both from `pending`). It was the only
  form control taking neither, so `aria-label` on an icon-only submit was a type
  error on the one button a workflow-app form has.
  
  `Markdown`, `Controls` and `MessageList` now name their props —
  `MarkdownProps`, `ControlsProps`, `MessageListProps` — so a wrapper can forward
  them without restating the shape, and so the published reference describes them
  at all: all three previously rendered as `MemoExoticComponent` with no props,
  leaving `Markdown`'s required `text` named nowhere.
  
  Documentation, throughout: component props are documented on the properties
  rather than in `@param` tags that TypeDoc discarded (eighteen components,
  including `AutoScroll`'s bounded-height requirement and `WorkflowProgress`'s
  `className`-replaces-the-default rule); every `SessionSnapshot` field and every
  `AgentState` member carries prose, `userTranscript`'s `null`-vs-`""` distinction
  included; `useWorkflowRun`, `useToolResult`, `useToolCallStart`, `useTheme`,
  `useSessionSelector`, `useWorkflows`, `createWorkflowApi`, `Field`,
  `SubmitButton`, `Markdown` and `ToolCallRow` gained examples; the two
  `useToolResult` / `useToolCallStart` overloads have their own descriptions
  instead of sharing one that said "optionally filter by tool name" on the
  overload taking no tool name; `WorkflowSubmission` and `WorkflowStreamSubmission`
  cross-reference each other and name the two fields that actually differ; and the
  README no longer tells readers to call `session.connect()`, which `Session` does
  not have.

### Patch Changes

- 23e8b3f: Document the `@alexkroman1/aai-ui/client-dir` subpath. It is published and has
  always carried a worked `createAgentServer` example on `defaultClientDir()`, but
  it was absent from the API reference — the package declared one TypeDoc entry
  point. It now has its own page, and its module comment carries an `@module` tag
  so the page is named after the subpath a consumer imports rather than the file
  TypeDoc read.
- Updated dependencies [12ead27]
- Updated dependencies [028044a]
- Updated dependencies [429126e]
- Updated dependencies [abfc018]
- Updated dependencies [43ceb43]
- Updated dependencies [8c9ce20]
- Updated dependencies [9b9051a]
- Updated dependencies [55d5ec1]
- Updated dependencies [d98169a]
- Updated dependencies [ea0c9c9]
- Updated dependencies [d1e7c56]
- Updated dependencies [abfc018]
- Updated dependencies [a7309a5]
- Updated dependencies [51d571d]
- Updated dependencies [43ceb43]
- Updated dependencies [6596e4b]
- Updated dependencies [df8effa]
- Updated dependencies [23e8b3f]
- Updated dependencies [abfc018]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
  - @alexkroman1/aai@7.0.0

## 6.11.0

### Patch Changes

- Updated dependencies [11e4892]
- Updated dependencies [91364b0]
- Updated dependencies [3d20929]
- Updated dependencies [0397945]
- Updated dependencies [12deeec]
- Updated dependencies [8958dd1]
- Updated dependencies [1602a0e]
- Updated dependencies [0da62af]
- Updated dependencies [70e3ceb]
- Updated dependencies [f433015]
- Updated dependencies [298f3f2]
- Updated dependencies [1602a0e]
  - @alexkroman1/aai@6.11.0

## 6.10.1

### Patch Changes

- Updated dependencies [5556ed5]
  - @alexkroman1/aai@6.10.1

## 6.10.0

### Patch Changes

- Updated dependencies [1a76804]
  - @alexkroman1/aai@6.10.0

## 6.9.1

### Patch Changes

- Updated dependencies [9d45c1e]
  - @alexkroman1/aai@6.9.1

## 6.9.0

### Minor Changes

- ebd3c39: Remember a workflow form's upload ids in sessionStorage, so a page reload resumes an interrupted upload instead of sending the file again. A recalled id is checked against the agent's own upload record before anything is sent to it: a complete upload skips the transfer entirely, an unfinished one with stored windows is resumed, and anything else gets a fresh id.
- a8e74a9: useAgentState now accepts a slot projection directly: `useAgentState(cartProjection)` infers the state's type from the projection and derives the pre-first-push frame by running it, memoized on the projection's identity. This closes a round-trip authors were wiring by hand — the projection had to be composed at both ends (`syncState` on the agent, again in the client) with nothing checking that the two named the same view, the empty frame was derived with `slot.projection(view)(undefined)`, and the state's type was restated three times. The two existing overloads are unchanged; prefer the `fallback` one only when a slot's `create()` is expensive to import into the browser, since the projection overload calls it.

### Patch Changes

- Updated dependencies [203c2d4]
- Updated dependencies [bbde9f9]
  - @alexkroman1/aai@6.9.0

## 6.8.0

### Minor Changes

- c7bb199: Resume an interrupted upload instead of losing it, and let a person pause one. A round that fails for a reason that looks like an outage — a redeploy, an idle sandbox reclaim, a dev-server restart — is re-entered with `resume: true` and sends only the windows the store does not have, on a budget that outlasts a restart. The same mechanism is exposed as `pauseUpload`/`resumeUpload` on both submit hooks, with a control on `<UploadProgressBar>` and `paused` on `UploadStatus`.

### Patch Changes

- @alexkroman1/aai@6.8.0

## 6.7.2

### Patch Changes

- 088eee6: Stop a workflow form submitting before the fields it validates exist.
  
  `<Form>` leans entirely on native validation — a `required` field is what blocks an empty submit — and `<WorkflowFields>` renders nothing until the workflow listing lands, so a click in that window submitted a form holding only its button. The browser had nothing to check, the payload was `{}`, and the agent answered with a schema complaint about a field the person had not been shown yet: `Invalid input for workflow "transcribeStream": recording: Invalid input`.
  
  A field set that fetches its own declaration now tells the enclosing form so, and the form disables the fieldset its submit button sits in until the fields arrive — the same fieldset that already covers an in-flight submit. The submit handler is guarded too, since Enter in a text field submits without a click. A hand-written form, and any `<Form>` used outside this package, is unaffected: no such child means nothing pending.
- Updated dependencies [7f2637c]
  - @alexkroman1/aai@6.7.2

## 6.7.1

### Patch Changes

- Updated dependencies [c46dac6]
  - @alexkroman1/aai@6.7.1

## 6.7.0

### Patch Changes

- Updated dependencies [9882411]
  - @alexkroman1/aai@6.7.0

## 6.6.0

### Patch Changes

- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
  - @alexkroman1/aai@6.6.0

## 6.5.1

### Patch Changes

- 153264f: `useWorkflowStream` refuses a submission whose payload still carries a `File` instead of starting a run over it. A File serializes to `{}`, so it arrived as an empty object and the workflow rejected its own input — reported in production as `recording: Invalid input` from a page whose file picker was working.
- Updated dependencies [58788ee]
- Updated dependencies [e2c2cda]
- Updated dependencies [153264f]
  - @alexkroman1/aai@6.5.1

## 6.5.0

### Patch Changes

- Updated dependencies [4da4327]
- Updated dependencies [4da4327]
  - @alexkroman1/aai@6.5.0

## 6.4.0

### Patch Changes

- Updated dependencies [5288539]
  - @alexkroman1/aai@6.4.0

## 6.3.1

### Patch Changes

- Updated dependencies [dd29277]
  - @alexkroman1/aai@6.3.1

## 6.3.0

### Patch Changes

- Updated dependencies [b04af38]
- Updated dependencies [2e103d8]
  - @alexkroman1/aai@6.3.0

## 6.2.0

### Minor Changes

- 295e8db: Tune the TTS playback path against a recorded reply: one fill target instead of two, a smaller pacer burst, a larger pacer lead, and a heard-cursor ear-lag that is no longer double-counting the client's buffer.
  
  `PLAYBACK_JITTER_MS` is deleted. It was redundant by construction: on a turn's first render the ring buffer is empty, so the underrun branch fires before any audio exists and arms the REFILL target — every turn already waited for that number, and the separate startup target could only act by being larger. Measured, `{jitter: 0, refill: R}` renders byte-identically to `{jitter: R, refill: R}`. One `PLAYBACK_FILL_MS` (200) takes 16-208 ms off time-to-first-audio depending on link quality, with concealment unchanged at zero.
  
  `PACER_BURST_MS` drops 200 to 100 and `CLIENT_AUDIO_LEAD_MS` rises 1000 to 1500. Together the longest link freeze the client rides out with no concealment goes 820 ms to 1453 ms, at no latency cost — time-to-first-audio is identical at every lead. What bounds the lead is bandwidth rather than correctness: a mid-reply barge-in discards ~1.3 s of pushed speech instead of ~0.85 s.
  
  `HEARD_AUDIO_LAG_MS` drops 750 to 150. It is applied on top of the playback clock, whose `endsAtMs` already tracks the client's unplayed backlog, so sizing it against the buffer depth double-counts it — which both its old derivation (the deleted fill target plus a network hop) and a first attempt at a new one (`CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS / 2`) did. Measured against the audio the ear actually received, the old value left the heard cursor ~694 ms early on a typical link, roughly ten words, which pushed toward the repetition `buildTailResumePrompt` exists to prevent. What is left for the term is the one-way network hop.
  
  `PIPELINE_PLAYBACK_GRACE_MS` is unchanged at 750, now with the measurement recorded: barge-in requires 15-138 ms of grace depending on the link, and does not scale with the pacer's lead.

### Patch Changes

- Updated dependencies [295e8db]
  - @alexkroman1/aai@6.2.0

## 6.1.0

### Patch Changes

- Updated dependencies [c4791cc]
- Updated dependencies [c4791cc]
- Updated dependencies [296b6c3]
  - @alexkroman1/aai@6.1.0

## 6.0.0

### Patch Changes

- 16bec88: Workflow hooks report a failure's own message rather than `[object Object]` when a rejection is message-bearing without being an `Error` — `useWorkflowRun` and `useWorkflows`/`useWorkflowSubmit` now unwrap it with the SDK's `errorMessage` instead of a local `instanceof Error` ternary.
- Updated dependencies [d81c752]
- Updated dependencies [4afb67c]
- Updated dependencies [0e99e1d]
- Updated dependencies [ae9e607]
- Updated dependencies [3df649f]
- Updated dependencies [263d86a]
- Updated dependencies [9fe4d07]
- Updated dependencies [b5fdd60]
- Updated dependencies [8c3c835]
- Updated dependencies [a9497a3]
- Updated dependencies [e923c72]
- Updated dependencies [8cf6ffa]
- Updated dependencies [3df649f]
- Updated dependencies [d325a71]
- Updated dependencies [a9497a3]
- Updated dependencies [0f7c4da]
- Updated dependencies [e923c72]
- Updated dependencies [d5667c4]
- Updated dependencies [0f7c4da]
- Updated dependencies [49ac025]
- Updated dependencies [f086dfe]
- Updated dependencies [d2a6b0d]
- Updated dependencies [0c411f4]
- Updated dependencies [d764fc6]
- Updated dependencies [d764fc6]
- Updated dependencies [cd03641]
- Updated dependencies [714cb82]
- Updated dependencies [eb0da5f]
- Updated dependencies [5e568e0]
- Updated dependencies [304347b]
- Updated dependencies [f037d0b]
- Updated dependencies [50282d6]
- Updated dependencies [6182917]
- Updated dependencies [0f7c4da]
- Updated dependencies [8ecbe38]
- Updated dependencies [02d90e3]
- Updated dependencies [9f74c34]
- Updated dependencies [61c6630]
- Updated dependencies [16bec88]
- Updated dependencies [97339d9]
- Updated dependencies [742bebf]
- Updated dependencies [c48f243]
- Updated dependencies [d5667c4]
- Updated dependencies [e4fd8c5]
  - @alexkroman1/aai@6.0.0

## 5.14.0

### Patch Changes

- Updated dependencies [df41665]
- Updated dependencies [24e8178]
  - @alexkroman1/aai@5.14.0

## 5.13.2

### Patch Changes

- 4ba7ab3: Keep a fatal session error on screen: the host's own teardown frames (a cancelled turn, a reply boundary) no longer clear the banner or paint a live-mic state over it, so a missing provider key stays visible instead of flashing for a fraction of a second.
  - @alexkroman1/aai@5.13.2

## 5.13.1

### Patch Changes

- Updated dependencies [7e92c96]
  - @alexkroman1/aai@5.13.1

## 5.13.0

### Patch Changes

- Updated dependencies [5cfe26b]
- Updated dependencies [90e5c15]
- Updated dependencies [cdc8e54]
- Updated dependencies [db4b0fb]
- Updated dependencies [ce45435]
- Updated dependencies [cdc8e54]
  - @alexkroman1/aai@5.13.0

## 5.12.0

### Patch Changes

- 42cf8ab: Fix six accessibility and responsive defects in the built-in UI components found by a manual browser QA pass: keyboard focus was invisible on every Button and URL chip (outline-none with no replacement, WCAG 2.4.7), buttons had no hover state at all, SidebarLayout squeezed ChatView to an unreadable column on phones instead of stacking, the Controls footer overflowed the viewport below 330px, a long tool name pushed ToolCallRow's expand chevron out of its clipped container, and the neutral text steps are now derived from the theme so a dark ClientTheme no longer leaves labels, tool details and chips below contrast minimums.
- 9fded19: Deadline the pre-connection client-config lookup. It runs inside the session's WebSocket URL provider, which partysocket awaits before arming any timeout of its own, so a platform that hung rather than failed meant no socket was ever constructed and none of the reconnect attempts ever ran — the session stayed on "connecting" indefinitely, including after the server recovered. A timed-out lookup now degrades like every other failed one.
- 9fded19: Fail a session whose socket opened but never received a config frame. The server sends config at zero RTT, so an open-but-silent socket means the peer is not a healthy agent server — but partysocket's connection timeout is cleared once the socket opens, so the session reached "ready" (the same live indicator the UI gives "listening") and stayed there permanently with no mic, no error and no retry. It now re-dials on a deadline and surfaces a connection error once the budget is spent.
- Updated dependencies [db3fb48]
- Updated dependencies [c49f501]
- Updated dependencies [db3fb48]
- Updated dependencies [a91c3bc]
- Updated dependencies [db3fb48]
- Updated dependencies [c49f501]
- Updated dependencies [348fa16]
- Updated dependencies [db3fb48]
  - @alexkroman1/aai@5.12.0

## 5.11.0

### Patch Changes

- Updated dependencies [e8d5e15]
  - @alexkroman1/aai@5.11.0

## 5.10.1

### Patch Changes

- @alexkroman1/aai@5.10.1

## 5.10.0

### Patch Changes

- 1c5056f: Fix two playback-drain races found by fuzzing aai-ui: a session torn down (hang up, fatal error, reconnect) mid-reply no longer has its dead state overwritten with "listening" when the drain settles, and a stale turn's worklet drain-stop can no longer settle the live turn early.
- Updated dependencies [b125465]
- Updated dependencies [1731876]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [fb7b545]
- Updated dependencies [b125465]
- Updated dependencies [c7617df]
- Updated dependencies [b125465]
- Updated dependencies [520900f]
- Updated dependencies [b125465]
- Updated dependencies [c524b76]
- Updated dependencies [b125465]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [ae9fd19]
- Updated dependencies [b125465]
- Updated dependencies [6ca79e0]
- Updated dependencies [b125465]
- Updated dependencies [fee8ece]
- Updated dependencies [ae9fd19]
- Updated dependencies [d8e34d8]
- Updated dependencies [a90296e]
- Updated dependencies [b125465]
- Updated dependencies [a82e54d]
- Updated dependencies [4b6e064]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [ae9fd19]
  - @alexkroman1/aai@5.10.0

## 5.9.0

### Patch Changes

- @alexkroman1/aai@5.9.0

## 5.8.1

### Patch Changes

- @alexkroman1/aai@5.8.1

## 5.8.0

### Patch Changes

- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
  - @alexkroman1/aai@5.8.0

## 5.7.0

### Patch Changes

- Updated dependencies [56efab9]
- Updated dependencies [1c034af]
  - @alexkroman1/aai@5.7.0

## 5.6.0

### Minor Changes

- 8b622e8: Share the tool console row and Markdown renderer with the studio: new ToolCallRow component export and a Markdown variant prop (default | compact) selecting the type scale.

### Patch Changes

- 8b622e8: Replace hand-rolled code with established libraries: HTML entity decoding via entities, <link> parsing via htmlparser2 (fixes entity-encoded hrefs and attribute values containing '>'), percent-decoded static asset paths in the dev server, a new internal createCoalescingRunner primitive, and use-stick-to-bottom for message-list auto-scroll (height changes no longer silently unpin the transcript).
- 77b0a80: Reset the session idle timer on conversational activity instead of on raw audio frames, and don't auto-reconnect after an idle retirement.
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [753665a]
- Updated dependencies [77b0a80]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [77b0a80]
  - @alexkroman1/aai@5.6.0

## 5.5.1

### Patch Changes

- Updated dependencies [1a6f800]
  - @alexkroman1/aai@5.5.1

## 5.5.0

### Minor Changes

- 966aeed: Add `session.end()`: hang up the call, clear the conversation, and return to the not-started state (`started` flips back to false). Unlike `reset()`, the next `start()` mints a brand-new session — new session id, fresh per-session tool state, greeting included. The retail template's End button now uses it, so clicking End properly toggles back to the Start screen (it previously only cleared the conversation while the call stayed live).

### Patch Changes

- Updated dependencies [a57905b]
- Updated dependencies [030b55f]
- Updated dependencies [6cca475]
- Updated dependencies [d303cfb]
- Updated dependencies [41d53ae]
  - @alexkroman1/aai@5.5.0

## 5.4.0

### Patch Changes

- 08dbc81: Allow `tools` display config alongside a custom `component` in `client()`. The provider already wrapped both tiers, so the labels were honoured at runtime; only the type rejected them.
- Updated dependencies [cb2de62]
- Updated dependencies [2198e2e]
- Updated dependencies [2198e2e]
- Updated dependencies [1d76583]
- Updated dependencies [5174cb2]
- Updated dependencies [aafe175]
  - @alexkroman1/aai@5.4.0

## 5.3.0

### Patch Changes

- Updated dependencies [27c5963]
- Updated dependencies [27c5963]
  - @alexkroman1/aai@5.3.0

## 5.2.0

### Patch Changes

- @alexkroman1/aai@5.2.0

## 5.1.1

### Patch Changes

- e47a187: Internal cleanups: prefetch audio modules at connect time so the chunk load overlaps the WebSocket handshake, remove per-frame Uint8Array view allocations on both audio hot paths, memoize the streaming message bubble and Markdown renderer map, drop the default console.warn audio diagnostics wiring, and dedupe URL/base-path helpers.
- Updated dependencies [b829155]
- Updated dependencies [ab577dc]
  - @alexkroman1/aai@5.1.1

## 5.1.0

### Minor Changes

- 3bc83bb: The API URL shown in the studio preview (and every default client) is now the
  long-living platform endpoint (`wss://host/:slug/websocket`) instead of the
  ephemeral sandbox tunnel URL, which dies on idle eviction or redeploy. The
  platform endpoint upgrades callers to the sandbox API itself: a plain
  WebSocket upgrade on `/:slug/websocket` resolves the agent's live sandbox
  (booting it on demand, like the client-config broker) and answers a 302
  redirect to the sandbox's current session URL, query preserved so
  `?sessionId=` resumes survive the hop.

### Patch Changes

- Updated dependencies [8fb0a0d]
- Updated dependencies [ac21a90]
  - @alexkroman1/aai@5.1.0

## 5.0.1

### Patch Changes

- fb4c14c: Never derive the public origin's scheme from the in-container request URL: behind Modal's TLS termination it is always cleartext http, which made studio Publish lose its Authorization header on the http→https redirect (401) and made the bare-slug redirect downgrade the scheme. A failed client-config lookup also no longer latches the session off the broker path.
  - @alexkroman1/aai@5.0.1

## 5.0.0

### Major Changes

- e8fef4b: Narrow the public export surface: remove registry/wire internals from the provider barrels (ASSEMBLYAI_LLM_KIND, GATEWAY_KIND, OPENROUTER_KIND, ASSEMBLYAI_TTS_KIND, CARTESIA_KIND, RIME_KIND, gateway URLs, ASSEMBLYAI_TTS_HOST, OPENROUTER_BASE_URL, default-voice constants), EMPTY_PARAMS/ExecuteTool/SessionMode from the manifest barrel, duplicate createRuntime/Runtime/RuntimeOptions/safeFetch/RunCodeExecutor re-export paths from the runtime barrel, and the WebSocketConstructor test-seam type from aai-ui. Provider factories, their Options/Provider types, and \*\_API_KEY_ENV constants are unchanged.

### Minor Changes

- 0c2bdbd: client({ name, component }) is allowed and sets the page title, instead of failing with a cryptic 'string is not assignable to undefined'.

### Patch Changes

- 0c2bdbd: ToolCallInfo.args carries permissive value types, matching useToolResult: reading a field off a tool call's arguments in a custom client was a compile error, and the cast agents reached for next was rejected as insufficiently overlapping.
- Updated dependencies [c36ad60]
- Updated dependencies [9b95fc9]
- Updated dependencies [5a599b2]
- Updated dependencies [e8fef4b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [25938b2]
- Updated dependencies [0c2bdbd]
- Updated dependencies [6fb3bc3]
- Updated dependencies [55e045b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [293da11]
- Updated dependencies [0c2bdbd]
- Updated dependencies [30914c9]
- Updated dependencies [0c2bdbd]
- Updated dependencies [01cecc1]
- Updated dependencies [d4c2a10]
- Updated dependencies [0c2bdbd]
- Updated dependencies [e8fef4b]
- Updated dependencies [293da11]
- Updated dependencies [e8fef4b]
- Updated dependencies [30914c9]
- Updated dependencies [fdd64ef]
- Updated dependencies [0c2bdbd]
  - @alexkroman1/aai@5.0.0

## 4.0.0

### Minor Changes

- 3125c8d: Render agent chat messages as Markdown in the default client UI (emphasis, lists, code, links, tables), with model-authored HTML kept escaped

### Patch Changes

- Updated dependencies [3e21af9]
- Updated dependencies [9ad4e51]
- Updated dependencies [b50b0e9]
- Updated dependencies [b50b0e9]
- Updated dependencies [577b17a]
- Updated dependencies [527c401]
  - @alexkroman1/aai@4.0.0

## 3.2.0

### Patch Changes

- 9c9eadb: Make a voice reply's transcript and audio reach the client together. Pipeline mode published a reply's transcript once, when the reply ended: a turn that opens with a tool chain speaks its hold phrase and dead-air cover tens of seconds before that, so any client pairing text with audio (live captions, a voice harness) had already played the audio by the time the words arrived. `agent_transcript` is now cumulative within a reply and sent as each piece of text reaches TTS; `aai-ui` renders it as the live assistant bubble and commits it to the conversation on `reply_done`. Host-mode sessions also opt out of audio pacing (`UNPACED_AUDIO_LEAD_MS`) — pacing assumes a client that plays at one second per second, and metering audio to the wall clock starves a programmatic client that keeps its own.
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
  - @alexkroman1/aai@3.2.0

## 3.1.0

### Patch Changes

- 369f950: Ship a favicon.ico on the studio and voice agent pages: the AssemblyAI mark is bundled with the studio client and the default agent client, served at /favicon.ico (studio) and /:slug/favicon.ico (agents, with a custom client's own favicon taking precedence).
- Updated dependencies [1749ca4]
  - @alexkroman1/aai@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [bb02ded]
- Updated dependencies [2b395b3]
- Updated dependencies [d917095]
- Updated dependencies [08f2937]
- Updated dependencies [bb02ded]
- Updated dependencies [2236275]
- Updated dependencies [2236275]
- Updated dependencies [2236275]
- Updated dependencies [eb9f662]
- Updated dependencies [6cac47f]
  - @alexkroman1/aai@3.0.0

## 2.0.0

### Major Changes

- 6047231: Remove the per-agent sync client transport and simplify the app model to two
  kinds: **agents** (WebSocket chat/voice sessions) and **workflows** (one-shot
  `POST /sync` runs).

  Breaking changes:

  - `agent({ transport })` is removed. The default browser client always uses
    the WebSocket session for agents; workflows automatically get the run
    surface. `POST /sync` remains available as a programmatic API for pipeline
    agents.
  - `agent({ kind })` is removed — `workflow()` is the only way to define a
    workflow.
  - `ClientTransport` and `assertClientTransport` are removed; `assertAgentKind`
    no longer takes a transport argument.
  - `GET /client-config` no longer returns a `transport` field (`kind` decides
    the surface); older responses still parse — the extra field is ignored.
  - aai-ui: `SyncChatView`, `startSyncMicrophone`, `createUtteranceDetector`,
    and their option types are removed. `createSyncSession` and
    `createPttRecorder` stay (they power `WorkflowView`). The chat shell now
    uses the server-declared agent name when `client({ name })` is not passed.
  - Templates `sync-voice` and `push-to-talk-translator` are removed.
  - The `@alexkroman1/aai/workflow` subpath (pattern combinators) is renamed to
    `@alexkroman1/aai/patterns`; the old subpath is removed.

### Minor Changes

- 41b5dad: Capture microphone audio with auto gain control, noise suppression, and voice isolation off (echo cancellation stays on), shared across every capture path as the exported VOICE_CAPTURE_CONSTRAINTS.

### Patch Changes

- Updated dependencies [377ecd3]
- Updated dependencies [e17fdc4]
- Updated dependencies [4051d7a]
- Updated dependencies [6047231]
- Updated dependencies [7fc476d]
- Updated dependencies [ed4f2e7]
- Updated dependencies [89a032d]
- Updated dependencies [158d5d5]
  - @alexkroman1/aai@2.0.0

## 1.16.0

### Patch Changes

- da2662a: Fix the sync-mode microphone going permanently deaf on its first flush: the capture worklet sized its next batch buffer from a view whose ArrayBuffer had just been transferred (and so detached to length 0), which wedged the audio render thread in an infinite loop posting empty chunks. No utterance was ever endpointed, so a sync agent never sent a turn. Also bound the sync session's replayed history to the server's own window and release the microphone when the view unmounts mid-startup.
- Updated dependencies [c261662]
- Updated dependencies [5ea4cba]
  - @alexkroman1/aai@1.16.0

## 1.15.0

### Patch Changes

- Updated dependencies [9ffec74]
- Updated dependencies [f87ff84]
  - @alexkroman1/aai@1.15.0

## 1.14.0

### Minor Changes

- f389673: The default sync client is now a hands-free voice agent: `SyncChatView`
  opens the microphone once via `startSyncMicrophone` and the client-side
  energy VAD endpoints each utterance automatically — no push-to-talk button.
  One toggle starts and ends the conversation; `createPttRecorder` remains
  exported for custom hold-to-record clients.

### Patch Changes

- Updated dependencies [1c57e05]
- Updated dependencies [4469856]
  - @alexkroman1/aai@1.14.0

## 1.13.1

### Patch Changes

- Updated dependencies [f662e45]
  - @alexkroman1/aai@1.13.1

## 1.13.0

### Minor Changes

- cbb8b71: Fix sync-mode microphone failing with "Unable to load a worklet's module": the capture worklet now loads from a blob URL (allowed by the agent page CSP) instead of a data URI (blocked). The export is renamed CAPTURE_WORKLET_DATA_URI -> CAPTURE_WORKLET_MODULE_URL, and the hold-to-record pipeline is now available as createPttRecorder. SyncChatView is rebuilt as a push-to-talk console in the same visual design as the WebSocket ChatView (logo + live-status eyebrow header, raised output card, design-system button): recording runs while the button is held, each release sends one POST /sync turn, and the view shows the transcript, the reply, and the endpoint the utterance is sent to.

### Patch Changes

- Updated dependencies [2b3c0e0]
  - @alexkroman1/aai@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [83be5b2]
- Updated dependencies [bd4405a]
  - @alexkroman1/aai@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [310eedb]
- Updated dependencies [a6bb262]
- Updated dependencies [d72c86b]
- Updated dependencies [163cb6f]
  - @alexkroman1/aai@1.11.0

## 1.10.0

### Minor Changes

- c147d23: aai-ui hardening from a full package review: fix a reconnect race that could double-run audio init (two live mics) by invalidating in-flight init on every retry; make mic denial on the text-only record button non-fatal instead of bricking the session; release the microphone on fatal server errors; keep straggler audio frames from flipping an errored session to speaking; recover error state to listening (not disconnected) on a live socket; honor pre-aborted AbortSignals in connect(); guard cancel() when disconnected; keep running=true when reset() reconnects; preserve the last ~100ms of speech on close via a capture-worklet stop ack; replace the stale-stop flag with reason-tagged playback stops so a barge-in at turn completion can't settle the next turn early; fire useToolCallStart for tool calls whose start/done frames coalesce into one commit; export Controls; widen the React peer range to ^19.0.0; bound server-sent config sample rates and transcript/error message sizes in the protocol schemas; document session IDs as sensitive.

### Patch Changes

- Updated dependencies [3fe3eff]
- Updated dependencies [5ddca41]
- Updated dependencies [133642f]
- Updated dependencies [fec3fa2]
- Updated dependencies [678556f]
- Updated dependencies [8a5ee8f]
  - @alexkroman1/aai@1.10.0

## 1.9.2

### Patch Changes

- @alexkroman1/aai@1.9.2

## 1.9.1

### Patch Changes

- Updated dependencies [713025a]
  - @alexkroman1/aai@1.9.1

## 1.9.0

### Minor Changes

- d718fe9: Redesign the default UI to the AssemblyAI design system (website refresh): warm cream default theme with deep-indigo primary, editorial serif headings, outlined eyebrow labels, rectangular ALL-CAPS buttons, the AssemblyAI wordmark, labeled agent prose with indigo-tinted user bubbles, and console-style expandable TOOL rows. The theme remains fully overridable via client({ theme }) and custom client.tsx.
- d718fe9: Show the session's UI and API URLs as a labeled pair (SessionUrlChips) instead of the API endpoint alone.

### Patch Changes

- 968c917: Internal cleanup of aai-ui: shared tint constants and JSON/truncate helpers, consolidated tool-call hook scaffolding, single-buffer mic batching, parallel audio setup, reusable resample buffer, and removal of the unused playback-progress machinery
- d718fe9: Default agent UI: paint html/body from the theme background so a cream theme no longer sits in a black letterbox on wide viewports.
- Updated dependencies [0235618]
- Updated dependencies [4758dfc]
- Updated dependencies [0f72bef]
- Updated dependencies [bc62b75]
- Updated dependencies [7e67c24]
- Updated dependencies [8817f3f]
- Updated dependencies [394867e]
- Updated dependencies [8004ff8]
- Updated dependencies [262f1e7]
- Updated dependencies [257a372]
- Updated dependencies [0bdb115]
- Updated dependencies [578a840]
- Updated dependencies [c5a5351]
- Updated dependencies [0235618]
- Updated dependencies [0235618]
- Updated dependencies [a252842]
- Updated dependencies [bbb9d73]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [a413caf]
- Updated dependencies [d718fe9]
- Updated dependencies [2898f21]
- Updated dependencies [882e7d9]
- Updated dependencies [e2ee4fd]
- Updated dependencies [9750db7]
- Updated dependencies [0d024e0]
- Updated dependencies [cb2821c]
- Updated dependencies [9aed108]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [ab38293]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [860bb7d]
- Updated dependencies [82f8253]
- Updated dependencies [d718fe9]
- Updated dependencies [7240ce5]
- Updated dependencies [f22b0f4]
- Updated dependencies [0bb1a20]
- Updated dependencies [7d4a193]
- Updated dependencies [5bf4d41]
- Updated dependencies [ad295be]
- Updated dependencies [d22d9f8]
- Updated dependencies [8f2093b]
- Updated dependencies [296a874]
- Updated dependencies [752af3d]
- Updated dependencies [38f02fa]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [82f8253]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [2fd1078]
- Updated dependencies [711edeb]
- Updated dependencies [fd5a54e]
- Updated dependencies [a413caf]
- Updated dependencies [3db093f]
- Updated dependencies [0c57887]
- Updated dependencies [79e51cb]
- Updated dependencies [d718fe9]
- Updated dependencies [0235618]
- Updated dependencies [cf56703]
- Updated dependencies [115a88e]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
  - @alexkroman1/aai@1.9.0

## 1.8.3

### Patch Changes

- 6b61892: Fix start-of-greeting audio cutoff in S2S mode. The client used to silently drop audio chunks that arrived from the server before `getUserMedia` and worklet registration completed. Early chunks are now buffered and replayed in order once playback is ready.
  - @alexkroman1/aai@1.8.3

## 1.8.2

### Patch Changes

- Updated dependencies [bb06b4e]
  - @alexkroman1/aai@1.8.2

## 1.8.1

### Patch Changes

- Updated dependencies [ba8effb]
- Updated dependencies [f4cc5ef]
  - @alexkroman1/aai@1.8.1

## 1.8.0

### Patch Changes

- Updated dependencies [a7384ad]
- Updated dependencies [cc013df]
  - @alexkroman1/aai@1.8.0

## 1.7.1

### Patch Changes

- Updated dependencies [3c711da]
  - @alexkroman1/aai@1.7.1

## 1.7.0

### Patch Changes

- Updated dependencies [07b4263]
- Updated dependencies [b79855d]
  - @alexkroman1/aai@1.7.0

## 1.6.1

### Patch Changes

- Updated dependencies [da84b47]
  - @alexkroman1/aai@1.6.1

## 1.6.0

### Patch Changes

- Updated dependencies [149786b]
- Updated dependencies [fd3a167]
- Updated dependencies [c8707d6]
- Updated dependencies [877348c]
  - @alexkroman1/aai@1.6.0

## 1.5.1

### Patch Changes

- Updated dependencies [fbb3816]
  - @alexkroman1/aai@1.5.1

## 1.5.0

### Minor Changes

- 58c5c75: Consolidate session.ts + pipeline-session.ts into a unified SessionCore with two transport strategies (S2S, pipeline). Switch connectS2s to typed callbacks (removing the nanoevents-backed S2sHandle emitter) and flatten client→server→provider dispatch from four layers to two. Wire format is JSON text events + raw PCM16 binary audio frames — the existing public protocol is unchanged. Adds Deepgram as a pipeline-mode STT option and Rime as a pipeline-mode TTS option.

### Patch Changes

- Updated dependencies [58c5c75]
- Updated dependencies [868b85e]
- Updated dependencies [a361363]
- Updated dependencies [58c5c75]
- Updated dependencies [58c5c75]
  - @alexkroman1/aai@1.5.0

## 1.4.5

### Patch Changes

- Updated dependencies [07dc8fb]
- Updated dependencies [2ca5d1f]
  - @alexkroman1/aai@1.4.5

## 1.4.4

### Patch Changes

- 9bd219f: Refine mic constraints: drop no-op sampleRate, add voiceIsolation + default deviceId, remove misleading AEC comment.
- Updated dependencies [74341a4]
  - @alexkroman1/aai@1.4.4

## 1.4.3

### Patch Changes

- Updated dependencies [62d5a99]
  - @alexkroman1/aai@1.4.3

## 1.4.2

### Patch Changes

- Updated dependencies [f877a6f]
  - @alexkroman1/aai@1.4.2

## 1.4.1

### Patch Changes

- Updated dependencies [63de397]
  - @alexkroman1/aai@1.4.1

## 1.4.0

### Patch Changes

- @alexkroman1/aai@1.4.0

## 1.3.2

### Patch Changes

- @alexkroman1/aai@1.3.2

## 1.3.1

### Patch Changes

- Updated dependencies [5a9f3d5]
  - @alexkroman1/aai@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [c95212a]
- Updated dependencies [f1a9764]
- Updated dependencies [f1a9764]
- Updated dependencies [0231114]
- Updated dependencies [8a79282]
- Updated dependencies [f1a9764]
  - @alexkroman1/aai@1.3.0

## 1.2.3

### Patch Changes

- 6a44b5b: Republish after the 1.2.2 release workflow failed (broken lockfile under `pnpm/action-setup@v6`). Also: `aai init` now skips deploy when `pnpm install` fails, so users see the real install error instead of a cryptic Rolldown `@alexkroman1/aai` resolution failure.
- Updated dependencies [6a44b5b]
  - @alexkroman1/aai@1.2.3

## 1.2.2

### Patch Changes

- Updated dependencies [534122c]
  - @alexkroman1/aai@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [7af69b8]
  - @alexkroman1/aai@1.2.1

## 1.2.0

### Patch Changes

- Updated dependencies [ed0dfbb]
- Updated dependencies [231ebc1]
  - @alexkroman1/aai@1.2.0

## 1.1.0

### Minor Changes

- 5cda7c5: Add ctx.send for real-time tool-to-client events

  Tools can now push arbitrary events to the browser client via `ctx.send(event, data)`. Events flow over the existing WebSocket as `custom_event` messages. The new `useEvent` React hook subscribes to named events. Migrated solo-rpg, pizza-ordering, dispatch-center, and night-owl templates from `useToolResult` to `ctx.send` + `useEvent`.

### Patch Changes

- f342260: Show AAI ANSI art logo on default start screen
- Updated dependencies [5cda7c5]
- Updated dependencies [41fab1a]
  - @alexkroman1/aai@1.1.0

## 1.0.6

### Patch Changes

- @alexkroman1/aai@1.0.6

## 1.0.5

### Patch Changes

- @alexkroman1/aai@1.0.5

## 1.0.4

### Patch Changes

- @alexkroman1/aai@1.0.4

## 1.0.3

### Patch Changes

- @alexkroman1/aai@1.0.3

## 1.0.2

### Patch Changes

- a3d3835: Force all libraries and the server to publish/deploy after the 1.0.1
  release failure. Restores the `@alexkroman1/` scope on publishable
  packages so npm accepts the publish, and bumps `aai-server` to trigger
  the Fly.io deploy job in the release workflow.
- Updated dependencies [76d25d4]
- Updated dependencies [a3d3835]
  - @alexkroman1/aai@1.0.2

## 1.0.1

### Patch Changes

- b4ff42e: Redeploy aai-server and refresh client/CLI/SDK releases
- Updated dependencies [5517333]
- Updated dependencies [5d55c12]
- Updated dependencies [b4ff42e]
  - aai@1.0.1

## 1.0.0

### Major Changes

- 7669733: Migrate aai-ui from Preact to React 19 with simplified API: useSession, useTheme, useToolResult hooks + two-tier defineClient
- 486fb23: Simplify aai-ui package: remove Reactive<T> abstraction, hardcode Preact signals, inline micro-components, merge createSessionControls into createVoiceSession, remove ./session subpath export.

  BREAKING CHANGES:

  - `createSessionControls` removed (merged into `createVoiceSession`)
  - `SessionSignals` type removed
  - `Reactive<T>` type removed
  - `useSession()` return shape changed (returns `VoiceSession` directly)
  - `VoiceSessionOptions` no longer accepts `reactiveFactory` or `batch`
  - `./session` subpath export removed
  - Components removed from exports: `ErrorBanner`, `StateIndicator`, `ThinkingIndicator`, `Transcript`, `MessageBubble`
  - `ButtonVariant`, `ButtonSize` types removed from exports
  - `ClientHandle.signals` removed (use `ClientHandle.session` directly)

### Minor Changes

- 8ecb7d1: Add protocol compat fixtures and harden wire format for rolling upgrades
- 9211c65: Add default aai-ui client served by the server when no custom client is deployed. Remove zod externalization from the worker bundler — zod 4 works natively in Deno sandboxes. Update S2S API endpoint and fix load test event handling.

### Patch Changes

- f6e7a5c: BREAKING: Align SDK naming with S2S API

  - `instructions` → `systemPrompt` in AgentOptions/AgentDef
  - `DEFAULT_INSTRUCTIONS` → `DEFAULT_SYSTEM_PROMPT`
  - `onTurn` → `onUserTranscript` hook
  - Protocol events renamed: `transcript` → `user_transcript_delta`, `turn` → `user_transcript`, `chat` → `agent_transcript`, `chat_delta` → `agent_transcript_delta`, `tts_done` → `reply_done`, `tool_call_start` → `tool_call`

- Updated dependencies [8ecb7d1]
- Updated dependencies [3bd18a9]
- Updated dependencies [befca9a]
- Updated dependencies [9211c65]
- Updated dependencies [b9b5c02]
- Updated dependencies [99db30d]
- Updated dependencies [5cc9550]
- Updated dependencies [4c1cd20]
- Updated dependencies [ab98c61]
- Updated dependencies [837e34f]
- Updated dependencies [f6e7a5c]
- Updated dependencies [7669733]
- Updated dependencies [14d0653]
- Updated dependencies [9d2141b]
- Updated dependencies [05f8759]
- Updated dependencies [1678546]
- Updated dependencies [5fd5cb3]
- Updated dependencies [64d83b6]
- Updated dependencies [6d3ec72]
  - aai@1.0.0

## 0.12.3

### Patch Changes

- 4ebd7b6: Standardize file and directory naming to idiomatic kebab-case conventions

  - Add ls-lint for file naming enforcement
  - Drop underscore prefix from internal files in aai-server (e.g. `_schemas.ts` → `schemas.ts`)
  - Rename `_components` → `components` and `__fixtures__` → `fixtures` in aai-ui
  - Rename `__fixtures__` → `fixtures` in aai/host
  - Flatten aai-server by removing `src/` directory

- 68f4d84: Make more cross platform
- Updated dependencies [4ebd7b6]
- Updated dependencies [68f4d84]
  - @alexkroman1/aai@0.12.3

## 0.12.2

### Patch Changes

- @alexkroman1/aai@0.12.2

## 0.12.1

### Patch Changes

- f4762a1: Externalize zod from agent bundles, remove storage cache, improve CI reliability
- Updated dependencies [f4762a1]
  - @alexkroman1/aai@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [99e62c3]
  - @alexkroman1/aai@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies [c25ee7e]
  - @alexkroman1/aai@0.11.1

## 0.11.0

### Patch Changes

- 491ec37: CLI overhaul: remove generate command, unify output style, template descriptions

  - Remove `generate` and `run` commands and AI SDK dependencies
  - Unify CLI output to use @clack/prompts style consistently
  - Add template descriptions shown as hints in `aai init` select prompt
  - Fix deploy slug mismatch between bundle and deploy steps
  - Clean deploy error messages (no stack traces)
  - Add `@alexkroman1/aai-cli` to scaffold devDependencies
  - Remove fly.toml from scaffold
  - Use cyanBright for all URLs in CLI output
  - Remove eventsource-parser patch
  - Add link-workspace-packages to .npmrc
  - Fix Dockerfile: run esbuild install script, remove patches references

- Updated dependencies [491ec37]
  - @alexkroman1/aai@0.11.0

## 0.10.4

### Patch Changes

- 6f6a43e: Harden platform security and refactor to @hono/zod-validator

  - Fix crash in sandbox-network when host.internal hit without handler
  - Add Zod validation to KV bridge (isolate→host) replacing raw JSON.parse
  - Refactor deploy, secret, and KV handlers to use @hono/zod-validator middleware
  - Fix type errors in \_harness-runtime.ts and sandbox.ts
  - Remove factory.ts, inline into orchestrator
  - Add 185 new security tests for cross-agent isolation, SSRF, and trust boundaries

- Updated dependencies [6f6a43e]
  - @alexkroman1/aai@0.10.4

## 0.10.3

### Patch Changes

- Updated dependencies [8d5f616]
  - @alexkroman1/aai@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies [9de059e]
- Updated dependencies [1397f37]
  - @alexkroman1/aai@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies [aa23a1c]
  - @alexkroman1/aai@0.10.1

## 0.10.0

### Minor Changes

- Replace LanceDB with sqlite-vec for vector storage, add `generate` CLI command, extract templates to giget, local dev mode improvements, auth cleanup, and graceful shutdown fixes

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.10.0

## 0.9.4

### Patch Changes

- Release all packages with version increment
- Updated dependencies
  - @alexkroman1/aai@0.9.4

## 0.9.3

### Patch Changes

- @alexkroman1/aai@0.9.3

## 0.9.2

### Patch Changes

- @alexkroman1/aai@0.9.2

## 0.9.1

### Patch Changes

- Update
- Updated dependencies
  - @alexkroman1/aai@0.9.1

## 0.9.0

### Minor Changes

- Updated toolchain

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.9.0
