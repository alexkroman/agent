// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 27 — the step slots.
 *
 * The second half of {@link ../testing/v27.ts | v27.ts} and part of the SAME
 * frozen example: the published slots a step reaches the outside world
 * through — the HTTP `stepFetch` makes, the upload store, the synthesizer, the
 * transcription provider, the subagent loop — plus what it narrates and which
 * attempt it is on. A separate module for one reason and it is not a taxonomy:
 * the example outgrew the 500-line source cap (`pnpm check:file-length`), and
 * the seam the file already had is the section banner. Every rule in `v27.ts`'s
 * header applies here unchanged: nothing below is ever invoked, the evidence is
 * that it type-checks, and editing it to make a future error go away defeats
 * the mechanism.
 *
 * The gate reads `v27.ts` by name (`fixturePath` in
 * `scripts/_api-contracts-tree.mjs` looks for exactly `v<N>.ts`), so that file
 * stays the entry point and this one is reached from it. Splitting the example
 * costs nothing the gate can see: what freezes an epoch is that the whole
 * package still COMPILES, and both halves are in the same program.
 */

import {
  routeStepFetch,
  STUB_SPEECH_PCM_BYTES,
  type StepRoute,
  type StepUnmatched,
  type StubEmitted,
  type StubGateway,
  type StubGatewayCall,
  type StubGatewayOptions,
  type StubGatewayRoute,
  type StubReporter,
  type StubSpeech,
  type StubSpeechCall,
  type StubSpeechOptions,
  type StubStepAnswer,
  type StubStepDelegate,
  type StubStepFetch,
  type StubStepRequest,
  type StubTranscribe,
  type StubTranscribeCall,
  type StubTranscribeFailure,
  type StubTranscribeLeg,
  type StubTranscribeOptions,
  type StubUpload,
  type StubUploads,
  type StubUploadsOptions,
  type StubUploadWrite,
  stubGateway,
  stubGatewayRoute,
  stubReporter,
  stubSpeech,
  stubStepDelegate,
  stubStepFetch,
  stubStepInfo,
  stubTranscribe,
  stubUploads,
} from "../../../sdk/testing-barrel.ts";
import {
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepDelegate,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
} from "../../../sdk/testing-vitest-barrel.ts";

// ── The outside world a step reaches ─────────────────────────────────────

/**
 * A refusal the gateway stages by STATUS rather than by minting an error.
 * `retry-after` is the field that makes it worth staging at all.
 */
const REFUSED: StubGatewayOptions = { status: 429, headers: { "retry-after": "2" } };

/** A page a step reads, as one route among several. */
const PAGE: StepRoute = (request: StubStepRequest): StubStepAnswer | undefined =>
  request.url === "https://example.com/" ? { body: "<p>hi</p>" } : undefined;

/**
 * Anything neither route recognises is a finding. Spelled as the union's own
 * member rather than a literal so a renamed arm reddens here.
 */
const UNMATCHED: StepUnmatched = "throw";

/** Composing a model leg with a page leg — epoch 27's one fake for two far sides. */
export function installWorld(replies: readonly string[]): {
  model: StubGatewayRoute;
  fetched: StubStepFetch;
} {
  const model = stubGatewayRoute(replies);
  return {
    model,
    fetched: stubStepFetch(routeStepFetch([model.route, PAGE], { unmatched: UNMATCHED })),
  };
}

/** The same, with the unwinding left to the runner. */
export function installWorldForThisTest(replies: readonly string[]): StubStepFetch {
  return installStubStepFetch(routeStepFetch([stubGatewayRoute(replies, REFUSED).route, PAGE]));
}

/** The global-fetch gateway, for a spec with no published slot. */
export function installGlobalGateway(reply: string): StubGateway {
  return stubGateway([reply]);
}

/** And its `/vitest` half, which hands back the call log directly. */
export function installGlobalGatewayForThisTest(reply: string): StubGatewayCall[] {
  return installStubGateway([reply], REFUSED);
}

/** What the model was ASKED, decoded. */
export function askedFor(gateway: StubGateway): StubGatewayCall | undefined {
  return gateway.calls[0];
}

// ── The published slots ──────────────────────────────────────────────────

/** A finished recording, and one that is still arriving. */
const RECORDING: StubUpload = {
  bytes: new Uint8Array([0, 0]),
  name: "call.wav",
  type: "audio/wav",
  complete: true,
};

/** The state a step polling an upload has to handle. */
const ARRIVING: StubUpload = { bytes: new Uint8Array([0]), complete: false };

/** Writes are OPT-IN, which is what makes the pair readable as an assertion. */
const UPLOADS: StubUploadsOptions = { writable: true, idPrefix: "up_test" };

/** The store, unwound by hand. */
export function makeUploads(): StubUploads {
  return stubUploads({ up_1: RECORDING, up_2: ARRIVING }, UPLOADS);
}

/** The store, unwound by the runner. */
export function installUploads(): StubUploads {
  return installStubUploads({ up_1: RECORDING, up_2: ARRIVING }, UPLOADS);
}

/** What a step stored, read back synchronously — outside the slot on purpose. */
export function wroteWav(store: StubUploads, id: string): StubUploadWrite | undefined {
  const written = store.read(id);
  return written?.type === "audio/wav" ? written : undefined;
}

/** Silence, at the length the contract names. */
const SPEECH: StubSpeechOptions = { pcmBytes: STUB_SPEECH_PCM_BYTES };

/** The synthesizer, unwound by hand. */
export function makeSpeech(): StubSpeech {
  return stubSpeech(SPEECH);
}

/** The synthesizer, unwound by the runner. */
export function installSpeech(): StubSpeech {
  return installStubSpeech(SPEECH);
}

/** What the step asked to be said, and in whose voice — a wrong voice id is silent in production. */
export function spoken(call: StubSpeechCall): string {
  return `${call.voice}/${call.language ?? "auto"}: ${call.text}`;
}

/** A rate limit on ONE leg, which is the case a retry has to survive. */
const RATE_LIMITED: StubTranscribeFailure = { leg: "submit", status: 429, retryAfterSeconds: 2 };

/** The provider, answering in memory. `pendingPolls` is what makes a POLL loop testable. */
const PROVIDER: StubTranscribeOptions = {
  text: ["Hello there.", "And the rest."],
  durationSec: 12,
  pendingPolls: 1,
  failure: RATE_LIMITED,
};

/** The provider, unwound by hand. */
export function makeProvider(): StubTranscribe {
  return stubTranscribe(PROVIDER);
}

/** The provider, unwound by the runner. */
export function installProvider(): StubTranscribe {
  return installStubTranscribe(PROVIDER);
}

/** Which leg one request was. */
function legOf(call: StubTranscribeCall): StubTranscribeLeg {
  return call.leg;
}

/** The legs the step really walked, in order — "upload once, submit once, poll until done". */
export function legsWalked(provider: StubTranscribe): StubTranscribeLeg[] {
  return provider.calls.map(legOf);
}

/** A subagent loop a STEP runs, answered from a script; the slot THROWS unpublished. */
export function makeDelegation(): StubStepDelegate {
  return stubStepDelegate({ researcher: "Three sources, one dissenting." });
}

/** The same, unwound by the runner. */
export function installDelegation(): StubStepDelegate {
  return installStubStepDelegate("One answer for every subagent.");
}

// ── What the step narrates ───────────────────────────────────────────────

/** The reporter, unwound by hand. */
export function narration(): StubReporter {
  return stubReporter();
}

/** The reporter, unwound by the runner. */
export function installNarration(): StubReporter {
  return installStubReporter();
}

/** The chunks one stream carried, kept apart from `lines` the way the streams are. */
export function chunksOn(reported: StubReporter, namespace: string): StubEmitted[] {
  return reported.emitted.filter((chunk) => chunk.namespace === namespace);
}

/**
 * The step's own attempt, so a body's DEGRADE-on-the-last-attempt branch is
 * reachable — outside a run `stepInfo()` answers `undefined`.
 */
export function onLastAttempt(): { restore: () => void } {
  return stubStepInfo({ attempt: 3, maxAttempts: 3, name: "transcribeSegment" });
}
