// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 19 — the step slots.
 *
 * The second half of {@link ../testing/v19.ts | v19.ts} and part of the SAME
 * frozen example: the four published slots a step reaches the outside world
 * through, plus what it narrates. It is a separate module for one reason and it
 * is not a taxonomy — the example outgrew the 500-line source cap
 * (`pnpm check:file-length`), and the seam the file already had is the section
 * banner. Every rule in `v19.ts`'s header applies here unchanged: nothing below
 * is ever invoked, the evidence is that it type-checks, and editing it to make a
 * future error go away defeats the mechanism.
 *
 * The gate reads `v19.ts` by name (`fixturePath` in
 * `scripts/_api-contracts-tree.mjs` looks for exactly `v<N>.ts`), so that file
 * stays the entry point and this one is reached from it. Splitting the example
 * costs nothing the gate can see: what freezes an epoch is that the whole
 * package still COMPILES, and both halves are in the same program.
 */

import {
  STUB_SPEECH_PCM_BYTES,
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
  stubStepFetch,
  stubStepInfo,
  stubTranscribe,
  stubUploads,
} from "../../../sdk/testing.ts";
import {
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
} from "../../../sdk/testing-vitest.ts";

// ── The outside world a step reaches ─────────────────────────────────────

/**
 * A refusal the gateway stages by STATUS rather than by minting an error.
 *
 * `retry-after` is the field that makes it worth staging at all: a fake that
 * threw the SDK's own error would be asserting the retryable-versus-terminal
 * classification the spec is trying to test.
 */
const REFUSED: StubGatewayOptions = { status: 429, headers: { "retry-after": "2" } };

/**
 * The hand-written composition — epoch 19's only way to fake two far sides.
 *
 * A model leg, then a throw for anything it does not recognise. Epoch 20's
 * `routeStepFetch` is this function; keeping it here is what proves an epoch-19
 * spec still compiles.
 */
export function handler(model: StubGatewayRoute): (r: StubStepRequest) => StubStepAnswer {
  return (request) => {
    const answered = model.route(request);
    if (answered === undefined) {
      throw new Error(`unexpected step request: ${request.method} ${request.url}`);
    }
    return answered;
  };
}

/** Publishing that handler, epoch 19. */
export function installWorld(replies: readonly string[]): {
  model: StubGatewayRoute;
  fetched: StubStepFetch;
} {
  const model = stubGatewayRoute(replies);
  return { model, fetched: stubStepFetch(handler(model)) };
}

/** The same, with the unwinding left to the runner. */
export function installWorldForThisTest(replies: readonly string[]): StubStepFetch {
  return installStubStepFetch(handler(stubGatewayRoute(replies, REFUSED)));
}

/** The global-fetch gateway, for a spec with no published slot. */
export function installGlobalGateway(reply: string): StubGateway {
  return stubGateway([reply]);
}

/** And its `/vitest` half, which hands back the call log directly. */
export function installGlobalGatewayForThisTest(reply: string): StubGatewayCall[] {
  return installStubGateway([reply], REFUSED);
}

/**
 * What the model was ASKED, decoded.
 *
 * `prompt` and `system` separately, because reading them off the raw request
 * means asserting against the serialized `model` and `temperature` too — which
 * one eval did, and was really testing its own request builder.
 */
export function askedFor(gateway: StubGateway): StubGatewayCall | undefined {
  return gateway.calls[0];
}

// ── The four published slots ─────────────────────────────────────────────

/** A finished recording, and one that is still arriving. */
const RECORDING: StubUpload = {
  bytes: new Uint8Array([0, 0]),
  name: "call.wav",
  type: "audio/wav",
  complete: true,
};

/**
 * The state a step polling an upload has to handle.
 *
 * A body that treats a stalled size as the end returns a transcript of most of
 * a recording and reports success, and a spec cannot catch that without an
 * incomplete upload to hand it.
 */
const ARRIVING: StubUpload = { bytes: new Uint8Array([0]), complete: false };

/**
 * Writes are OPT-IN, which is what makes the pair readable as an assertion: a
 * read-only store cannot accept one, so `writes` staying empty is the same fact
 * as the step never having tried.
 */
const UPLOADS: StubUploadsOptions = { writable: true, idPrefix: "up_test" };

/** The store, unwound by hand. */
export function makeUploads(): StubUploads {
  return stubUploads({ up_1: RECORDING, up_2: ARRIVING }, UPLOADS);
}

/** The store, unwound by the runner. */
export function installUploads(): StubUploads {
  return installStubUploads({ up_1: RECORDING, up_2: ARRIVING }, UPLOADS);
}

/**
 * What a step stored, read back synchronously.
 *
 * Outside the published slot on purpose: a spec asserting on bytes should not
 * have to `await readUpload` through the very seam it is testing.
 */
export function wroteWav(store: StubUploads, id: string): StubUploadWrite | undefined {
  const written = store.read(id);
  return written?.type === "audio/wav" ? written : undefined;
}

/**
 * Silence, at the length the contract names.
 *
 * Naming the constant rather than a number is the point: nothing downstream of
 * a step LISTENS, so the only thing a spec can assert about synthesized audio is
 * how much of it there is, and a literal here would be a spec asserting its own
 * arithmetic.
 */
const SPEECH: StubSpeechOptions = { pcmBytes: STUB_SPEECH_PCM_BYTES };

/** The synthesizer, unwound by hand. */
export function makeSpeech(): StubSpeech {
  return stubSpeech(SPEECH);
}

/** The synthesizer, unwound by the runner. */
export function installSpeech(): StubSpeech {
  return installStubSpeech(SPEECH);
}

/**
 * What the step asked to be said, and in whose voice.
 *
 * The voice is the field worth asserting: a wrong voice id is a SILENT failure
 * in production — the service accepts the socket and refuses in band — so the
 * only place it can be caught is here.
 */
export function spoken(call: StubSpeechCall): string {
  return `${call.voice}/${call.language ?? "auto"}: ${call.text}`;
}

/** A rate limit on ONE leg, which is the case a retry has to survive. */
const RATE_LIMITED: StubTranscribeFailure = { leg: "submit", status: 429, retryAfterSeconds: 2 };

/**
 * The provider, answering in memory.
 *
 * `pendingPolls` is what makes a POLL loop testable at all: a job that is
 * finished on the first read never exercises the branch the loop exists for.
 */
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

/**
 * The legs the step really walked, in order.
 *
 * The assertion this exists for is "upload once, submit once, poll until done" —
 * a body that re-uploaded on every retry passes every other check in a spec and
 * shows up only here.
 */
export function legsWalked(provider: StubTranscribe): StubTranscribeLeg[] {
  return provider.calls.map(legOf);
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

/**
 * The chunks one stream carried.
 *
 * `emitted` is kept apart from `lines` the way the streams are, so a spec
 * asserting a chunk never has to filter the sentences out of it — and a page
 * depending on the SHAPE of those chunks has nowhere else to see them.
 */
export function chunksOn(reported: StubReporter, namespace: string): StubEmitted[] {
  return reported.emitted.filter((chunk) => chunk.namespace === namespace);
}

/**
 * The step's own attempt, so a body's DEGRADE-on-the-last-attempt branch is
 * reachable.
 *
 * Outside a run `stepInfo()` answers `undefined`, which a body reads as "not
 * retrying" — so the branch that exists precisely for the case that goes wrong
 * was the branch no test could enter.
 */
export function onLastAttempt(): { restore: () => void } {
  return stubStepInfo({ attempt: 3, maxAttempts: 3, name: "transcribeSegment" });
}
