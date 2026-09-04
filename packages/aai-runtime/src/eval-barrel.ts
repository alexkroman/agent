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
 * `openEvalWorkflows` is the same idea for a `workflowApp()`, which has no
 * session at all: it starts a real run of the real body over an in-process
 * engine. **That engine is not durable** — see `eval/workflow-engine.ts`, which
 * carries the whole account and the four `WorkflowClient` methods that have no
 * honest answer without a queue. Its `client` is also what
 * {@link openEvalSession}'s `workflows` option takes, which is what makes a
 * VOICE agent's run-starting tool executable in an eval.
 *
 * The assertion READERS ({@link saidIn}, {@link toolCallsIn}, {@link TURN_ENDS},
 * {@link toolArgsIn}, {@link toolResultIn}, {@link toolResultsIn},
 * {@link lastStateIn}, {@link statesIn}, {@link customEventsIn},
 * {@link toolNames}, {@link callsIn}, {@link turnCalling},
 * {@link completedOutput}) are here rather than a vocabulary of matchers because
 * an eval already has a runner: `expect` in a vitest file is the simple case, and
 * a case that must PROFILE rather than bisect on the first failure wants a
 * recording runner, which is a different tool. What both need is one honest
 * answer to "what did the agent say" and "which tools did it call". Each of them
 * THROWS rather than returning something empty when it has nothing to read —
 * that is the half a hand-rolled `find`/`?? ""` gets wrong, and it turns a case
 * asserting against `undefined` into a case that names what actually happened.
 *
 * The two DIAGNOSTICS ({@link describeToolCalls}, {@link describeTurn}) are the
 * same idea for the runner's own half: a reader that throws says what happened,
 * and an `expect` that fails says "expected undefined to be defined" unless the
 * case hands it a message. Ten sites across five templates hand-built that
 * message, four of them byte-identically, which is what says it belongs here.
 *
 * Exports are enumerated explicitly (no `export *`) so the public surface is
 * deliberate: a new symbol in one of these modules does not ship as public API
 * until it is added here.
 *
 * @module eval
 */

// The two types a CASE names, re-exported so an eval imports from this subpath
// and nothing else.
//
// That is not a convenience. `@alexkroman1/aai-runtime`'s root barrel reaches
// `agent-server.ts` → `server.ts` → `workflow-install.ts` → `step-fetch.ts`, so
// a template eval that imports the root for one type drags the runtime's
// node-reaching modules into a program that may have no node types — three
// `BodyInit`/`exactOptionalPropertyTypes` errors in files the eval never calls.
// It happened the day this shipped, in three template evals reaching for
// `RunCodeExecutor`. Same hazard `@alexkroman1/aai/host-internal`'s own note
// records, arriving by a new route.
export type { RunCodeExecutor, StepFetch } from "@alexkroman1/aai/host-internal";
export {
  customEventsIn,
  describeToolCalls,
  type EvalToolCall,
  lastStateIn,
  saidIn,
  statesIn,
  TURN_ENDS,
  toolArgsIn,
  toolCallsIn,
  toolNames,
  toolResultIn,
  toolResultsIn,
} from "./eval/events.ts";
// The fake speech stages, and the env var they resolve their unused credential
// from. Public because the seam is the interesting part: they register through
// `registerSttKind`/`registerTtsKind` like any provider, so a harness of your
// own — one that paces real PCM, or scripts a provider failure — is written the
// same way rather than against a private hook.
export {
  createStubSttOpener,
  createStubTtsOpener,
  STUB_SPEECH_API_KEY_ENV,
  type StubSpeechProviders,
  type StubSttSession,
  type StubTtsSession,
  installStubSpeechProviders,
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
export {
  installStubLlm,
  STUB_LLM_API_KEY_ENV,
  type StubLlm,
  type StubScript,
  type StubStep,
} from "./eval/stub-llm.ts";
// Reading a CALL rather than one reply. Public because the claim they make is
// the one a multi-turn case has to make and could not spell: the turn a
// MECHANISM fired in, never turn number two — how many turns an agent takes to
// get somewhere is the model's business and it measurably varies, so a case
// pinned to an index is a flake with a misleading name. Three templates reached
// that conclusion independently and wrote these three out under it.
export { callsIn, describeTurn, turnCalling } from "./eval/turns.ts";
// The `node:vm` `run_code` executor. Public because the `run_code` builtin
// REFUSES without one off-platform (the Modal container is the security
// boundary), so a case about an agent that answers by running code cannot assert
// the answer at all until a host supplies this — and four template evals had
// each written the same eleven lines to get one.
export { createVmRunCode, type VmRunCodeOptions } from "./eval/vm-run-code.ts";
// The two records a workflow run leaves behind. Public because they are what a
// case asserts on, and because the SLEEP one is the harness admitting what it
// cannot do: a durable suspension is recorded, never taken.
export type { EvalEmitted, EvalSleep } from "./eval/workflow-engine.ts";
// Driving a WORKFLOW. The engine underneath is NOT durable — no journal, no
// replay, no retry — and `eval/workflow-engine.ts` is where that is spelled out;
// a case declared here may not be reported as covering any of the three.
export {
  completedOutput,
  type EvalRunOptions,
  type EvalWorkflowRun,
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  evalWorkflowCredentials,
  openEvalWorkflows,
} from "./eval/workflows.ts";
