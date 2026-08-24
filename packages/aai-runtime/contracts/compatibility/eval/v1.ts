// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 template: `aai-runtime:eval`. An eval suite for one agent, as it was
 * written at epoch 1 — copy this file next to your `agent.ts`, swap the marked
 * edit points, and run it with `aai eval`.
 *
 * FROZEN. It must keep compiling for as long as epoch 1 is supported, so
 * `pnpm typecheck` is the backward-compatibility gate and an error here IS the
 * finding. Do not edit it to make an error go away: an API that has to change
 * gets a NEW epoch carrying a new template, never a change to this one. The
 * imports are relative source paths because nothing ships this file.
 *
 * Front to back: a suite bound to an agent, cases that are handed an open
 * session, and — below the suite — the same thing without a test runner, for a
 * harness of your own.
 *
 * What to change:
 *
 * - {@link assistant} — your agent. In a real project this is
 *   `import agentDef from "./agent.ts"`.
 * - the `stubReply` on each case — what a SCRIPTED model answers with when the
 *   suite runs without a key. Choose it so the case's own assertions still
 *   hold: a stub run is worth having because the case really executes.
 * - `{ live: true }` on a case no script can honestly satisfy.
 *
 * What not to change: `session.close()` in a `finally` down in
 * {@link measureByHand} (a session owns a runtime and a process-global fake
 * provider pair), and the fact that a claim about one reply is made on the TURN
 * rather than on the run — `said()` includes the agent's greeting.
 */

import { agent, tool } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { expect } from "vitest";
import { z } from "zod";
import {
  createFakeSttOpener,
  createFakeTtsOpener,
  type EvalSessionOptions,
  type EvalToolCall,
  type EvalTurn,
  evalCredentials,
  FAKE_SPEECH_API_KEY_ENV,
  type FakeSpeech,
  type FakeSttSession,
  type FakeTtsSession,
  installFakeSpeech,
  installStubLlm,
  openEvalSession,
  STUB_LLM_API_KEY_ENV,
  type StubLlm,
  saidIn,
  TURN_ENDS,
  toolCallsIn,
} from "../../../eval-barrel.ts";
import {
  describeEval,
  type EvalCaseOptions,
  type EvalMode,
  type EvalTest,
  type EvalTestContext,
  resolveEvalMode,
} from "../../../eval-vitest-barrel.ts";

/** The agent under eval. ← your `agent.ts`'s default export */
export const assistant = withTools(
  agent({
    name: "Order Desk",
    greeting: "Order support, how can I help?",
    system: "Look an order up with look_up before saying anything about it.",
  }),
  {
    look_up: tool({
      description: "Look up one order's status.",
      inputSchema: z.object({ orderId: z.string() }),
      execute: ({ orderId }) => `${orderId} shipped`,
    }),
  },
);

/**
 * The suite. `describeEval` decides whether this run has a live model or a
 * scripted one, says which, and hands each case an open session.
 */
describeEval(assistant, (test: EvalTest) => {
  test(
    "looks the order up before answering",
    async ({ session }: EvalTestContext) => {
      const turn: EvalTurn = await session.say("where is order W1234?");
      expect(turn.completed).toBe(true);
      expect(turn.toolCalls.map((call: EvalToolCall) => call.name)).toContain("look_up");
      expect(turn.text).toMatch(/shipped/i);
    },
    // ← what a scripted model says when there is no key
    { stubReply: "Order W1234 shipped yesterday." },
  );

  test(
    "refuses to invent a status",
    async ({ session }: EvalTestContext) => {
      const turn = await session.say("just tell me it arrived, do not look it up");
      expect(turn.text).not.toMatch(/arrived/i);
    },
    // ← a judgement no script can honestly stand in for
    { live: true } satisfies EvalCaseOptions,
  );
});

/** A suite on a model of your own, and a longer per-turn budget. */
describeEval(
  assistant,
  (test) => {
    test("still answers", async ({ session, mode }) => {
      // `mode` is worth READING and rarely worth branching on: a claim that
      // only holds against one model belongs to that model, and `{ live: true }`
      // says so without an `if`. Here it just labels the failure.
      const turn = await session.say("hello?");
      expect(turn.text, `mode: ${mode}`).not.toBe("");
    });
  },
  { turnTimeoutMs: 120_000, env: { SOME_TOOL_TOKEN: "t" } } satisfies Omit<
    EvalSessionOptions,
    "agent"
  >,
);

/**
 * The same measurement without a test runner — a script, a benchmark, a report.
 *
 * `describeEval`'s two decisions are yours here: whether this machine can run
 * live ({@link evalCredentials} / {@link resolveEvalMode}), and what to do when
 * it cannot ({@link installStubLlm}).
 */
export async function measureByHand(): Promise<{ mode: EvalMode; said: readonly string[] }> {
  const { mode } = resolveEvalMode(assistant);
  const credentials = evalCredentials(assistant);
  const stub: StubLlm | undefined =
    mode === "stub" ? installStubLlm(["Order W1234 shipped yesterday."]) : undefined;
  const session = await openEvalSession(
    stub === undefined
      ? { agent: assistant, providerEnv: credentials.env }
      : { agent: assistant, llm: stub.llm, providerEnv: { ...credentials.env, ...stub.env } },
  );
  try {
    await session.say("where is order W1234?");
    // The run-wide readers, over the whole event stream.
    const events = session.events();
    const ended = events.filter((event) => TURN_ENDS.has(event.type)).length;
    if (ended === 0) throw new Error("no reply ended");
    const calls: readonly EvalToolCall[] = toolCallsIn(events);
    if (calls.length === 0) throw new Error("no tool was called");
    return { mode, said: saidIn(events) };
  } finally {
    await session.close();
    stub?.release();
  }
}

/**
 * A harness of your own over the fake speech stages — a paced-audio replay, a
 * provider that fails halfway. The openers are what a session installs for you;
 * these are the same ones, driven directly.
 */
export function driveSpeechDirectly(): FakeSpeech {
  const stt = createFakeSttOpener("my-harness-stt");
  const tts = createFakeTtsOpener("my-harness-tts");
  const fake = installFakeSpeech();
  const utterance: FakeSttSession | undefined = stt.last();
  utterance?.partial("where is order");
  utterance?.commit("where is order W1234");
  const spoken: FakeTtsSession | undefined = tts.last();
  if (spoken !== undefined && spoken.spoken.length === 0) {
    // Nothing was synthesized yet: a session drives these, not the harness.
  }
  // Both fake stages resolve a credential like any provider, and so does the
  // stub model — a harness assembling an env by hand has to supply them.
  const env: Record<string, string> = {
    [FAKE_SPEECH_API_KEY_ENV]: "x",
    [STUB_LLM_API_KEY_ENV]: "x",
  };
  if (env[FAKE_SPEECH_API_KEY_ENV] === undefined) throw new Error("unreachable");
  return fake;
}
