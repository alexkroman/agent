// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-runtime/eval` — driving an agent from TEXT, to evaluate
 * what it did.
 *
 * The gap this closes: unit tests exercise modules, and a fuzz harness asserts
 * that generated orderings break no invariant. Neither answers **given this
 * utterance, did the agent do the right thing** — did it call the right tool,
 * with the right arguments, in the right order, and say the right thing. That
 * question needs the real runtime, the real LLM loop, the real tool executor and
 * the real session event stream, with only the two speech stages replaced, which
 * is exactly what {@link openEvalSession} stands up.
 *
 * ```ts no-check
 * import { openEvalSession } from "@alexkroman1/aai-runtime/eval";
 * import agentDef from "./agent.ts";
 *
 * const session = await openEvalSession({ agent: agentDef });
 * try {
 *   const turn = await session.say("hi, what can you do?");
 *   if (!/order/i.test(turn.text)) throw new Error(`said: ${turn.text}`);
 * } finally {
 *   await session.close();
 * }
 * ```
 *
 * In a vitest project, reach for `describeEval` from
 * `@alexkroman1/aai-runtime/eval/vitest` instead — it owns the credential gate,
 * the scripted-model fallback and the per-case session, so a case is its
 * assertions and nothing else.
 *
 * **What it does NOT measure**: everything below the audio boundary —
 * endpointing, splits and merges, barge-in, and the
 * `speech.started`/`reply.cancelled` ratio. Those are properties of the boundary
 * the fake stages remove, and no assertion driven through this can say anything
 * about one. Do not name or report an eval written here in a way that implies
 * they are covered; `eval/session.ts` and `eval/fake-speech.ts` repeat the
 * warning at the seams where it would be forgotten.
 *
 * The three assertion READERS ({@link saidIn}, {@link toolCallsIn},
 * {@link TURN_ENDS}) are here rather than a vocabulary of matchers because an
 * eval already has a runner: `expect` in a vitest file is the simple case, and a
 * case that must PROFILE rather than bisect on the first failure wants a
 * recording runner, which is a different tool. What both need is one honest
 * answer to "what did the agent say" and "which tools did it call".
 *
 * Exports are enumerated explicitly (no `export *`) so the public surface is
 * deliberate: a new symbol in one of these modules does not ship as public API
 * until it is added here.
 *
 * @module eval
 */

export {
  type EvalToolCall,
  saidIn,
  TURN_ENDS,
  toolCallsIn,
} from "./eval/events.ts";
// The fake speech stages, and the env var they resolve their unused credential
// from. Public because the seam is the interesting part: they register through
// `registerSttKind`/`registerTtsKind` like any provider, so a harness of your
// own — one that paces real PCM, or scripts a provider failure — is written the
// same way rather than against a private hook.
export {
  createFakeSttOpener,
  createFakeTtsOpener,
  FAKE_SPEECH_API_KEY_ENV,
  type FakeSpeech,
  type FakeSttSession,
  type FakeTtsSession,
  installFakeSpeech,
} from "./eval/fake-speech.ts";
export {
  type EvalCredentials,
  type EvalSession,
  type EvalSessionOptions,
  type EvalTurn,
  evalCredentials,
  openEvalSession,
} from "./eval/session.ts";
// The scripted model a keyless run falls back to. Public because the FALLBACK
// is public policy: a suite that runs without a credential is checking wiring
// rather than behaviour, and a harness of its own has to be able to say so.
export { installStubLlm, STUB_LLM_API_KEY_ENV, type StubLlm } from "./eval/stub-llm.ts";
