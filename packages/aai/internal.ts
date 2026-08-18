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
 * once in the SDK. The root keeps only the constants that document an
 * `agent()` field.
 *
 * Named re-exports rather than `export *`: the wildcard form needs a
 * `noReExportAll` suppression, and the escape-hatch ratchet only moves down.
 *
 * @module internal
 */

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
export {
  type CoalescingRunner,
  createCoalescingRunner,
} from "./sdk/coalescing-runner.ts";
// The Content-Security-Policy every agent UI is served under, and the
// WebSocket readyState the client checks — both shared with `aai-server` and
// `aai-ui`, neither anything an agent declares.
export { AGENT_CSP, WS_OPEN } from "./sdk/constants.ts";
export { createEpoch, type Epoch } from "./sdk/epoch.ts";
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
export { formatSchemaIssues } from "./sdk/schema.ts";
// The one `sleep`. Here rather than on `/utils` because that subpath is where a
// `workflows/*.ts` module imports its step surface from, and the DevKit's own
// DURABLE `sleep` is imported from "workflow" in those same files — see the
// module doc.
export { type SleepOptions, sleep } from "./sdk/sleep.ts";
// The unavailable-workflows trio. Here rather than on the root barrel because all
// three are `@internal`: their readers are the tool executor, the two
// test-context builders, and the guest harness. Keeping them off the root also
// keeps them out of the docs surface, which a `@public` `{@link}` to an
// `@internal` symbol would otherwise fail the docs build over.
export {
  MISSING_WORKFLOW_ID_MESSAGE,
  rejectingWorkflows,
  WORKFLOWS_UNAVAILABLE_MESSAGE,
} from "./sdk/workflow-unavailable.ts";
export { parseWsUpgradeParams } from "./sdk/ws-upgrade.ts";
