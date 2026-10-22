// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `testing-client`.
 *
 * Testing what a step delivers to a DEVICE: the recording inbox behind
 * `stepNotifyClient`/`stepSayOnClient` (`stubClientInbox`, and its `/vitest`
 * installer) and the scripted transcript `stepClientTranscript` reads
 * (`stubClientTranscript`).
 *
 * Split off `testing` because these fakes move with the client-inbox steps, not
 * with a tool's context. Part of the `testing` family: `aai-runtime`'s
 * `testing-stubs` door mirrors the whole family.
 *
 * This file is not shipped and nothing imports it — it exists so
 * `pnpm check:api-contracts` can extract a report for this capability alone,
 * hash it, and hold it to a committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
  type StubClientInbox,
  type StubClientInboxCall,
  type StubClientInboxOptions,
  type StubClientTranscript,
  type StubClientTranscriptAnswer,
  type StubClientTranscriptCall,
  stubClientInbox,
  stubClientTranscript,
} from "../../sdk/testing-barrel.ts";
export { installStubClientInbox } from "../../sdk/testing-vitest-barrel.ts";
