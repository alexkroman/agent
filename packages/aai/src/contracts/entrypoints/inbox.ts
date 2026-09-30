// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `inbox`.
 *
 * Reaching a device after its voice session closed: the tool side reads which
 * device a session belongs to (`sessionClientId`, on `@alexkroman1/aai`), and
 * a workflow step pushes to that device's `WS /inbox` socket
 * (`stepNotifyClient` and what it takes and throws, on
 * `@alexkroman1/aai/step`).
 *
 * One capability across two subpaths because the two halves are one contract:
 * the id a tool hands a run is the id the step addresses, and a change to
 * either is a change to how a device is reached.
 *
 * This file is not shipped and nothing imports it — it exists so
 * `pnpm check:api-contracts` can extract a report for this capability alone,
 * hash it, and hold it to a committed epoch. See `scripts/api-contracts.mjs`.
 */

export { requireSessionClient, sessionClientId } from "../../index.ts";
// The client's durable conversation, read back from a step — the other half of
// "a device has one conversation": `onSessionEnd` starts the run, this reads
// what was said.
export {
  type ClientNotice,
  type ClientTranscript,
  type ClientTranscriptMessage,
  type ClientTranscriptSession,
  type ClientTranscriptTool,
  ClientUnreachableError,
  type ClientUnreachableReason,
  DEFAULT_CLIENT_ACK_TIMEOUT_MS,
  DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
  DEFAULT_CLIENT_RETRY_MS,
  // A failed run said on the device: the same delivery, with the failure's id
  // and `data.failed`, as a `workflow({ onFailure })` handler.
  type SayFailureOnClientOptions,
  type StepClientTranscriptOptions,
  type StepNotifyClientOptions,
  type StepSayOnClientOptions,
  sayFailureOnClient,
  stepClientTranscript,
  stepNotifyClient,
  stepSayOnClient,
} from "../../sdk/step-barrel.ts";
