// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-package infrastructure this package needs to hand on, and nothing an
 * embedder writes an agent against.
 *
 * Every name here is a re-export of `@alexkroman1/aai/host-internal`, which the
 * SDK itself deny-lists from its contracted surface as "the SDK internals
 * `@alexkroman1/aai-runtime` needs across the package boundary; not
 * semver-covered" (`NON_AUTHORING_SUBPATHS` in
 * `scripts/_api-contracts-tree.mjs`). They used to sit on this package's ROOT
 * barrel, which put fifty not-semver-covered names on the one surface an
 * embedder autocompletes over — and defeated the SDK's own exemption one
 * package over, since the exemption is per SUBPATH and the re-export minted a
 * new one.
 *
 * A release tag cannot fix that from here: API Extractor reads `@internal` at
 * the DECLARATION site, so a `/** @internal *\/` on a re-export clause member is
 * silently ignored (verified — the name stays `@public` in the report). A
 * subpath is the mechanism this repo already uses twice, for exactly this, and
 * `NON_AUTHORING_SUBPATHS` carries the matching entry so a name arriving here
 * joins no capability contract.
 *
 * @module internal
 */

// The publisher half of the step env — the READER (`stepEnv`) is authoring API
// on `@alexkroman1/aai/utils`, and lives in `sdk/` because the step bundle
// bundles it. Only a host calls this: the guest at bundle load, `aai dev` on
// every rebuild.
// The four step slots' publishers. `installWorkflowSupport` below is what
// calls all of them for an ordinary server; these are for a process that
// assembles its own.
// The two sizes an upload is measured in, plus the id grammar. Exported for the
// PLATFORM, which owns the byte route a deployed guest brokers through: its window
// cap and its key derivation have to be stated in the same units the SDK cuts in,
// and a second copy of either number is a silent disagreement about where an object
// begins. Not on an authoring subpath — an agent author never picks these.
export {
  type BuiltinToolOptions,
  builtinFetch,
  CONTAINED_ENV,
  isPrivateIp,
  pinnedFetch,
  publishSpeechSynthesizer,
  publishStepEnv,
  publishStepFetch,
  publishStepReporter,
  publishUploadReader,
  type ResolvedBuiltins,
  resolveAllBuiltins,
  resolveAndAssertPublic,
  resolveBuiltin,
  SANDBOX_ONLY_BUILTINS,
  SPEECH_UNAVAILABLE_MESSAGE,
  type SpeechSynthesizer,
  type StepFetch,
  type StepReporter,
  safeFetch,
  ssrfSafeFetch,
  type ToolDefRecord,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_PART_BYTES,
  UPLOAD_TOKEN_RE,
  UPLOAD_WRITES_UNAVAILABLE_MESSAGE,
  UPLOADS_UNAVAILABLE_MESSAGE,
  type UploadAccess,
  type UploadReader, // `UploadAccess` is an intersection of these two, and a type a public
  // signature MENTIONS but does not export is a docs-build warning — see the
  // `UploadRange` note in `sdk/utils.ts` for the rule.
  type UploadWriteMeta,
  type UploadWriter,
} from "@alexkroman1/aai/host-internal";
