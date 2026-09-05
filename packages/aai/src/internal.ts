// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/internal` — infrastructure shared with the sibling
 * packages (`aai-ui`, `aai-server`, …), NOT part of the public SDK API and
 * not covered by semver. Agents and client code should never import from
 * here; everything an `agent.ts` or `client.tsx` needs lives on the root
 * export and the documented subpaths.
 *
 * These modules used to ride on the root barrel, where they drowned the
 * four-symbol authoring API (`agent`, `tool`, `assemblyAIPipeline`,
 * `assemblyAIS2s`) in autocomplete noise. Keeping them on their own subpath
 * keeps the root importable surface honest.
 *
 * The framework BUDGETS below arrived the same way and for the same reason:
 * `sdk/constants.ts` is where every magic number in the repo is declared, the
 * root barrel re-exported the module wholesale, and so a jitter-buffer depth
 * and a WebSocket close code sat in an agent author's autocomplete beside
 * `greeting`. They are here rather than deleted because the browser client
 * genuinely needs them — the client-audio budgets are one half of wire paths
 * whose other half the host enforces, which is exactly why they are declared
 * once in the SDK. That subtraction is finished: the root keeps ONE constant
 * (`DEFAULT_SYSTEM_PROMPT`, which an author composes against) and every other
 * budget and documented default is here.
 *
 * **This subpath is ZOD-FREE, and that is now a rule rather than an accident.**
 * It used to reach `formatSchemaIssues` through `sdk/schema.ts`, which imports
 * zod, so importing anything here pulled zod's module graph — which is exactly
 * the startup cost `sdk/utils.ts` exists to keep off the CLI's path, and it is
 * what kept the slug contract and the wire helpers on a PUBLISHED subpath they
 * had no business being on. The function itself lives in the zod-free
 * `sdk/standard-schema.ts`; importing it from there is the whole fix.
 *
 * Named re-exports rather than `export *`: the wildcard form needs a
 * `noReExportAll` suppression, and the escape-hatch ratchet only moves down.
 *
 * @module internal
 */

// The framework's own wire helpers — see `sdk/_wire-helpers.ts`'s module doc.
export {
  capToolResult,
  isTextAssetPath,
  normalizeSpeechText,
  toArgsRecord,
} from "./sdk/_wire-helpers.ts";
// The workflow API's route prefix — the SERVER's half, with the wait clamp
// below. A caller of a deployed agent composes no URL of its own.
export { WORKFLOW_API_PREFIX } from "./sdk/_workflow-api-envelope.ts";
// The opening line, for the same reason: a greeting is REPLACED rather than
// composed, so no `agent.ts` names it — while a client rendering it before a
// socket exists does.
export { DEFAULT_GREETING } from "./sdk/agent-defaults.ts";
// The `aai login` confirmation code and the slug shape: the two contracts BOTH
// ends of a platform interaction must derive identically. They were on `/utils`,
// which is a published subpath an agent author reads — a platform contract is
// not authoring API, and neither end that derives one is an agent.
export { linkConfirmationCode } from "./sdk/cli-link.ts";
// Client-audio budgets: the browser client's half of wire paths the host
// enforces the other half of (e.g. MAX_CLIENT_WS_BUFFERED_BYTES), which is why
// they are declared in the SDK and not in `aai-ui`.
//
// `CLIENT_AUDIO_LEAD_MS` and `PACER_BURST_MS` are the SERVER's pacing and are
// here for one reason: they decide how much audio the browser's playback buffer
// holds, so `aai-ui`'s playback bench cannot measure anything real without them.
// It used to re-spell both as literals, which made the one number the whole
// measurement rests on a copy that nothing checked.
export {
  CAPTURE_STOP_ACK_TIMEOUT_MS,
  CLIENT_AUDIO_LEAD_MS,
  MAX_PLAYBACK_BUFFERED_MS,
  MIC_BUFFER_SECONDS,
  MIC_SEND_MAX_BUFFERED_BYTES,
  MIC_SILENCE_PROBE_MS,
  PACER_BURST_MS,
  PLAYBACK_BUFFER_SECONDS,
  PLAYBACK_CONCEAL_FADE_MS,
  PLAYBACK_CONCEAL_FLOOR,
  PLAYBACK_DONE_MAX_WAIT_MS,
  PLAYBACK_DONE_POLL_MS,
  PLAYBACK_FILL_MS,
  PLAYBACK_PROGRESS_INTERVAL_MS,
} from "./sdk/client-audio-constants.ts";
// The one rule `ctx.send` applies, shared so the runtime that enforces it and
// the test double that has to agree with it cannot drift — see
// `sdk/client-event.ts`.
export {
  type ClientEventDecision,
  type ClientEventDrop,
  clientEventDropMessage,
  decideClientEvent,
} from "./sdk/client-event.ts";
export {
  type CoalescingRunner,
  createCoalescingRunner,
} from "./sdk/coalescing-runner.ts";
/**
 * The Content-Security-Policy every agent UI is served under, the WebSocket
 * readyState the client checks, and the DOCUMENTED DEFAULTS.
 *
 * The defaults arrived here in the same move that emptied `sdk/constants.ts`
 * off the root barrel. They were kept there on the argument that each one
 * documents an `agent()` field — but the field's JSDoc already carries the
 * value, so the constant added nothing an author reads, and no template, no
 * scaffold and no line of the shipped authoring guide ever named one. Who does
 * read them is exactly this subpath's audience, and the `defaults` capability's
 * own frozen example had said so out loud all along: "a client sizing a buffer,
 * a harness matching the host's endpointing, a test asserting the shipped
 * value." All three are framework readers.
 *
 * They are still the one declaration of each value, still the constants the
 * runtime resolves a missing field to, and still assertable by a test. What
 * changed is that reproducing a default is no longer advertised as authoring
 * API. `DEFAULT_SYSTEM_PROMPT` is the exception and stayed on the root, because
 * `agent({ systemPrompt })` replaces it wholesale and composing against it is
 * the documented recipe — see `index.ts`.
 */
export {
  AGENT_CSP,
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_ERROR_PHRASE,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_BARGE_IN_WORDS,
  DEFAULT_MIN_TURN_SILENCE_MS,
  DEFAULT_SILENCE_PROMPT,
  DEFAULT_START_FAILURE_PHRASE,
  DEFAULT_STT_PROMPT,
  DEFAULT_TOOL_CHOICE,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_CLIENT_EVENT_PAYLOAD_BYTES,
  MAX_TOOL_RESULT_CHARS,
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_RESULT_TRUNCATION_MARKER,
  WS_OPEN,
} from "./sdk/constants.ts";
// The two budgets around `ctx.db`. A tool body reads the handle; the row cap
// and the not-enabled message are what the driver and the guest mirror enforce.
export { type Db, MAX_DB_RESULT_ROWS } from "./sdk/db.ts";
export { createEpoch, type Epoch } from "./sdk/epoch.ts";
export {
  type InvariantDetail,
  InvariantViolation,
  invariant,
  isInvariantViolation,
} from "./sdk/invariant.ts";
// The repo's one always-on oracle. Here rather than on an authoring subpath
// because an agent author never states one: an invariant is about a property the
// FRAMEWORK maintains, and the packages that maintain them are the siblings.
// Exponential backoff with jitter — the one spelling, shared by the three
// upload retry paths that had each written it. Here rather than on
// `./host-internal` because there is no host in it: it is arithmetic, and the
// next plausible caller is a BROWSER reconnect loop. See the module doc for why
// the jitter, rather than the doubling, is the half worth sharing.
export { type JitteredBackoffOptions, jitteredBackoff } from "./sdk/jittered-backoff.ts";
export { createOwnedMap, type OwnedMap } from "./sdk/owned-map.ts";
// The two halves of one physical delay — how long between the server handing a
// frame to the socket and the caller hearing it. Exported for the same reason as
// the pacing above: the bench that measures that delay lives in `aai-ui`, and a
// constant it cannot import is a constant it can only restate.
export {
  HEARD_AUDIO_LAG_MS,
  PIPELINE_PLAYBACK_GRACE_MS,
} from "./sdk/playback-timing-constants.ts";
export { requestPath, requestQuery } from "./sdk/request-url.ts";
// The one `sleep`, and it is the WALL-CLOCK one. Off the authoring subpaths so
// it cannot be mistaken for the durable wait a workflow body wants, which is
// `ctx.sleep` — that one SUSPENDS the run, where this one holds a timer open.
// Its options are `SleepTimerOptions` for the same reason one name over: the
// root barrel's `SleepOptions` is `ctx.sleep`'s, and two option types one
// `sleep` apart is a collision an auto-import resolves silently. See the
// module doc.
export { type SleepTimerOptions, sleep } from "./sdk/sleep.ts";
export {
  MAX_SLUG_LENGTH,
  PREVIEW_SLUG_SUFFIX,
  RESERVED_SLUGS,
  VALID_SLUG_RE,
} from "./sdk/slug.ts";
// From `standard-schema.ts`, not from the `schema.ts` that re-exports it: this
// function is zod-free and that module is not, so routing through it would pull
// zod's graph into every importer of this subpath — the startup cost the
// `/utils` module doc has always guarded, now guarded here too.
export { formatSchemaIssues } from "./sdk/standard-schema.ts";
// The carrier vocabulary an agent's `telephony` declaration is written in.
// The TYPES are authoring API and live on the root barrel beside `AgentDef`;
// this is the list as a VALUE, which `aai-runtime` needs to resolve a
// declaration into the routes it serves and to pin `CARRIER_CODECS` to the
// same names. A value on the root barrel would be an authoring export nothing
// in an `agent.ts` has a use for.
export { TELEPHONY_CARRIERS } from "./sdk/telephony-config.ts";
/**
 * The SERVER's half of the workflow HTTP API.
 *
 * `@alexkroman1/aai/workflow-api` is the CLIENT of what a deployed agent
 * answers — a page, a script, a cron job. These four were on it and had
 * `@alexkroman1/aai-runtime` as their only importer: the thing that ANSWERS
 * those routes, plus the studio's own docs page quoting the prefix.
 * `clampWorkflowWait` is the clearest — its doc says both ends share it, and the
 * browser client does, through a relative import inside
 * `sdk/workflow-api-client.ts`. The public export existed only so the runtime
 * could reach the same copy; a caller passes `wait` a number and the client
 * clamps it.
 *
 * The four `ctx.workflows` option bags plus `AnyWorkflowDef`/`WorkflowBody` have
 * the same single importer and did NOT come with them: they are the parameter
 * and member types of `WorkflowClient` and `WorkflowDef`, which are root-barrel
 * authoring API, so a type a public signature names has to stay reachable from a
 * documented entry point. `sdk/workflow-api-barrel.ts` carries what the docs
 * build said when they were moved.
 */
export {
  clampWorkflowWait,
  MAX_WORKFLOW_WAIT_MS,
  TERMINAL_WORKFLOW_STATUSES,
} from "./sdk/workflow-run.ts";
// There is no suspend BRAND here any more, and its absence records a design
// that is gone rather than a name that moved. The engine's suspend signal was
// branded with a `Symbol.for` because it travelled OUT through a workflow body
// and back, so `instanceof` could not be trusted across the copies of this SDK a
// guest bundle holds. It no longer travels anywhere: a suspension is raised on a
// channel the body has no reference to and recognised by identity within one
// `replayRun` call. See `aai-runtime/workflow-replay-suspend.ts`.

// The unavailable-workflows trio. Here rather than on the root barrel because all
// three are `@internal`: their readers are the tool executor, the two
// test-context builders, and the guest harness. Keeping them off the root also
// keeps them out of the docs surface, which a `@public` `{@link}` to an
// `@internal` symbol would otherwise fail the docs build over.
export {
  rejectingWorkflows,
  WORKFLOWS_UNAVAILABLE_MESSAGE,
} from "./sdk/workflow-unavailable.ts";
export { parseWsUpgradeParams } from "./sdk/ws-upgrade.ts";
