// Copyright 2026 the AAI authors. MIT license.
/**
 * Every {@link SessionErrorCode} has a declared INJECTION SITE and a declared
 * RECOVERY, or it is declared client-minted. There is no third state.
 *
 * ## The defect class
 *
 * `SessionErrorCode` is eight values and `fatal` is the field that decides what
 * a client does with one — `aai-ui` answers a fatal frame by releasing the
 * microphone and ending the call, where a non-fatal one is a banner over a
 * session that keeps running (`session-core-state.ts`). The two are
 * INDEPENDENT: `protocol-events.ts` says so outright, and every bug in this
 * family has been a reporter choosing the wrong `fatal` rather than the wrong
 * code. The census, all of it fixed at the site that produced it:
 *
 * - Both S2S transports reported every in-band service error as fatal. None of
 *   those closes the socket, so the conversation demonstrably continued — tool
 *   calls, replies and audio all arrived — to a client that had already
 *   released the microphone.
 * - The pipeline's LLM reporters were fatal while the transport's very next act
 *   is to speak `errorPhrase` ("Could you say that again?"), so the caller was
 *   asked to repeat themselves into a session the client had torn down.
 * - The TTS drain timeout was fatal, ending a live call over one clipped
 *   sentence.
 *
 * Fixing them one site at a time leaves the class open, and the reason is that
 * nothing enumerates the codes at the BEHAVIOUR level. The only enumeration in
 * the tree before this file was `protocol.test.ts`'s `test.each(ERROR_CODES)`,
 * which asserts the schema PARSES each one — green whatever any emitter does
 * with it.
 *
 * ## What this table is
 *
 * One row per way a session error is really produced, declaring the code, the
 * `fatal` the wire carries, and what the session does NEXT — which is the half
 * a code alone cannot express and the half every bug above got wrong.
 * {@link unclassifiedCodes} is the gate: a code named by no row and declared in
 * no {@link CLIENT_MINTED_CODES} entry fails the suite, so a ninth code cannot
 * land without somebody stating what recovery means for it.
 *
 * **A row is not evidence on its own** — {@link SessionErrorSite.driven} is
 * what says whether anything exercises it. `"here"` means
 * `error-injection.integration.test.ts` injects at that site and asserts the
 * frame; anything else names the file that does and why this suite cannot.
 * That field exists because the failure mode of a table like this is a row
 * everybody believes and nothing runs.
 *
 * @internal Test infrastructure, not part of any public API.
 */

import { type SessionErrorCode, SessionErrorCodeSchema } from "@alexkroman1/aai/protocol";

/**
 * What the session does after the frame — the half `code` cannot express.
 *
 * Deliberately three values and not a boolean over `fatal`. `fatal` is what the
 * WIRE says; this is what the runtime then does, and the two can disagree in a
 * way that is invisible to a client: a `terminated` site that forgot to close
 * its provider link leaves a billed session running behind a call the client
 * has ended, which is the `endSession` bug recorded in `packages/aai/CLAUDE.md`.
 */
export type SessionErrorRecovery =
  /** The session is over: the transport tears down and the client ends the call. */
  | "terminated"
  /**
   * The TURN is over and the session is not. The conversation continues and the
   * caller is invited to speak again — so the frame must be `fatal: false`, or
   * the invitation goes to a client that has switched the microphone off.
   */
  | "turn-recovered"
  /**
   * Neither the turn nor the session ends: the frame exists so a failure is
   * VISIBLE. A tool that threw is the case — the model still gets the failure
   * and the turn runs on.
   */
  | "reported-only";

/** Where a row is exercised, if anywhere. */
export type SessionErrorDriven =
  /** `error-injection.integration.test.ts` injects here and asserts the frame. */
  | "here"
  /** Exercised somewhere else, or nowhere — `why` has to say which. */
  | {
      /** Repo-relative file that drives it, or the module that would have to. */
      readonly owner: string;
      /** Why this suite cannot drive it. Read as prose in a failure message. */
      readonly why: string;
    };

/** One way a session error is really produced. */
export interface SessionErrorSite {
  /** `<code>.<what-happened>`, unique across the table. */
  readonly site: string;
  /** The code the frame carries. */
  readonly code: SessionErrorCode;
  /**
   * The `fatal` the frame carries.
   *
   * `createEmitError` defaults it to `true`, so a reporter that says nothing
   * means the terminal case — which is why every turn-level site here states
   * `false` explicitly rather than inheriting a default that ends the call.
   */
  readonly fatal: boolean;
  /** Which transport produces it, or `"session"` for the socket layer above them. */
  readonly transport: "pipeline" | "s2s" | "openai-realtime" | "session";
  readonly recovery: SessionErrorRecovery;
  readonly driven: SessionErrorDriven;
}

/**
 * Every site, and the whole argument for each `fatal` value is the recovery
 * beside it: a site that invites another turn may not end the call.
 */
export const SESSION_ERROR_SITES: readonly SessionErrorSite[] = [
  // ── Provider open: the session never becomes a session ────────────────────
  {
    site: "stt.open-rejected",
    code: "stt",
    fatal: true,
    transport: "pipeline",
    // A session whose STT never opened cannot hear anyone, which is one of the
    // exactly two pipeline paths that may report the session over.
    recovery: "terminated",
    driven: "here",
  },
  {
    site: "tts.open-rejected",
    code: "tts",
    fatal: true,
    transport: "pipeline",
    recovery: "terminated",
    driven: "here",
  },

  // ── Provider stream: the link was live and died ───────────────────────────
  {
    site: "stt.stream-error",
    code: "stt",
    fatal: true,
    transport: "pipeline",
    // `onProviderError` calls `terminate()`. The other pipeline path that may
    // omit `fatal`; everything below this line is turn-level.
    recovery: "terminated",
    driven: "here",
  },
  {
    site: "tts.stream-error",
    code: "tts",
    fatal: true,
    transport: "pipeline",
    recovery: "terminated",
    driven: "here",
  },

  // ── The turn engine: a failing TURN is not a failing SESSION ──────────────
  {
    site: "llm.stream-error-part",
    code: "llm",
    fatal: false,
    transport: "pipeline",
    recovery: "turn-recovered",
    driven: "here",
  },
  {
    site: "llm.request-refused",
    code: "llm",
    fatal: false,
    transport: "pipeline",
    // A separate code path from the stream part above — `streamText` throwing
    // rather than yielding an `error` part — and the pipeline fuzz's fatality
    // oracle covers both for the same reason they are two rows here.
    recovery: "turn-recovered",
    driven: "here",
  },
  {
    site: "tts.drain-timeout",
    code: "tts",
    fatal: false,
    transport: "pipeline",
    // The reply is audibly clipped and the session is not over: the turn
    // resynchronizes (`tts.cancel()`) and the conversation continues.
    recovery: "turn-recovered",
    driven: "here",
  },
  {
    site: "tool.execute-threw",
    code: "tool",
    fatal: false,
    transport: "pipeline",
    recovery: "reported-only",
    driven: {
      owner: "packages/aai-runtime/src/runtime-tools.ts",
      why:
        "the frame is minted by the RUNTIME's `onUncaught` wiring, not by the transport — " +
        "`PipelineTransportOptions.executeTool` is a seam a spec supplies, and a throw " +
        "through it never reaches this code. `tool-executor.test.ts` covers the callback " +
        "and nothing covers the frame, which is a real gap rather than a division of " +
        "labour: driving it needs `createRuntime`, not `createPipelineTransport`.",
    },
  },

  // ── The socket layer above the transports ─────────────────────────────────
  {
    site: "protocol.frame-declined",
    code: "protocol",
    fatal: true,
    transport: "session",
    recovery: "terminated",
    driven: {
      owner: "packages/aai-runtime/src/session-decline.ts",
      why:
        "produced by the WebSocket upgrade path rather than by any transport — a frame " +
        "that does not parse, or one sent in a state with no answer for it, is refused " +
        "before a transport exists to inject into.",
    },
  },
  {
    site: "internal.session-crashed",
    code: "internal",
    fatal: true,
    transport: "session",
    recovery: "terminated",
    driven: {
      owner: "packages/aai-runtime/src/ws-handler.ts",
      why: "the catch-all for a session that failed to build; there is no transport yet.",
    },
  },

  // ── S2S: the vendor owns the turn, so the codes differ ────────────────────
  {
    site: "internal.s2s-service-error",
    code: "internal",
    fatal: false,
    transport: "s2s",
    // The service's own in-band `error` frame does NOT close the socket — the
    // conversation continues — so reporting it fatal left a session that looked
    // live and was deaf. See `packages/aai/CLAUDE.md`.
    recovery: "reported-only",
    driven: {
      owner: "packages/aai-runtime/src/integration/s2s-fuzz.integration.test.ts",
      why:
        "the S2S property test already generates service errors against a model that IS " +
        "the provider state machine, so a frame this suite injected by hand would be a " +
        "second, weaker copy of it.",
    },
  },
  {
    site: "connection.link-lost",
    code: "connection",
    fatal: true,
    transport: "s2s",
    // The ONE S2S reporter of session death: the close/failed-resume path, which
    // is the only place that knows the link is gone.
    recovery: "terminated",
    driven: {
      owner: "packages/aai-runtime/src/integration/s2s-fuzz.integration.test.ts",
      why: "same harness as the row above; its command grammar generates transient and fatal drops.",
    },
  },
];

/**
 * Codes the RUNTIME emits NOWHERE, with the client site that mints one instead.
 *
 * The classification half, and the first thing this table found. `audio` is a
 * real wire code, is parsed by `SessionErrorCodeSchema`, is documented in
 * `protocol-events.ts` as "the audio path: a rate the transport cannot honour,
 * a decode" — and no server-side reporter in this repo has ever produced one.
 * It reaches a client only because the client MINTS it for its own failures,
 * which means the documented server-side meaning describes nothing.
 *
 * That is a decision to make rather than a hole to fill, which is why this is a
 * declaration and not a TODO: either the host's rate refusal
 * (`assertHostRatesSupported`) should report `audio` instead of the code it
 * currently uses, or the doc should say the code is client-minted. What it may
 * not be is silence — a code nobody has thought about is what every bug in this
 * file's module doc was.
 */
export const CLIENT_MINTED_CODES: Readonly<Record<string, string>> = {
  audio:
    "no runtime reporter emits it; `aai-ui`'s session-core-audio-setup.ts mints one locally " +
    "when the browser audio path dies, which is a client-side failure the server never sees.",
};

/**
 * Codes named by no site row and declared in no {@link CLIENT_MINTED_CODES}
 * entry — i.e. the ones nobody has classified.
 *
 * Derived from `SessionErrorCodeSchema.options` rather than from a list written
 * here, so a code ADDED to the union arrives unclassified and fails the gate.
 * A hand-copied list would agree with the schema on the day it was written and
 * never again.
 */
export function unclassifiedCodes(): SessionErrorCode[] {
  const covered = new Set<string>(SESSION_ERROR_SITES.map((s) => s.code));
  return SessionErrorCodeSchema.options.filter(
    (code) => !covered.has(code) && CLIENT_MINTED_CODES[code] === undefined,
  );
}

/** The rows this suite is expected to inject at and assert on. */
export function drivenHere(): SessionErrorSite[] {
  return SESSION_ERROR_SITES.filter((s) => s.driven === "here");
}
