// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:eval` epoch 1.
 *
 * This must keep compiling against current source for as long as epoch 1 is
 * advertised as supported. Editing it to make an error go away defeats the
 * mechanism — the error IS the finding, and the answer is a source fix or
 * `node scripts/api-contracts.mjs --bump aai-runtime:eval --drop "<reason>"`.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's sixty-seven exports.** The gate requires it
 * (`api-contracts-gate.test.ts`, "frozen examples import what its epochs
 * promised") and the reason is worth understanding: a fixture that names one
 * signature freezes one signature, while every other name in the epoch compiles
 * because nothing mentions it. The coverage deny-list is a RATCHET whose entries
 * may only be deleted, so "import it and use it" is the only route. That is why
 * the back half of this file is a roll-call rather than a story — the front half
 * is the part written to be read.
 *
 * **Its imports are RELATIVE.** The same gate insists, and rightly: importing
 * `@alexkroman1/aai-runtime/eval` would resolve through the package's own
 * `exports` map to whatever the current build publishes, so the fixture would
 * prove the CURRENT surface compiles rather than that epoch 1's does.
 *
 * Nothing here uses `expectCalled` or `lastToolResultIn`. Those are what moved
 * the capability to epoch 2, and this file is the promise about the one before.
 *
 * @module
 */

import { agent, tool } from "@alexkroman1/aai";
import { toolRegistry, withTools } from "@alexkroman1/aai/manifest";
import { expect } from "vitest";
import { z } from "zod";
import {
  completedOutput,
  createStubSttOpener,
  createStubTtsOpener,
  createVmRunCode,
  customEventsIn,
  DEFAULT_RUN_TIMEOUT_MS,
  describeToolCalls,
  describeTurn,
  type EvalCredentials,
  type EvalEmitted,
  type EvalRunOptions,
  type EvalSession,
  type EvalSessionOptions,
  type EvalSleep,
  type EvalTextAgent,
  type EvalTextAgentOptions,
  type EvalToolCall,
  type EvalTurn,
  type EvalWorkflowEngineOptions,
  type EvalWorkflowRun,
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  errorsIn,
  evalCredentials,
  evalWorkflowCredentials,
  expectToolBeforeSpeech,
  type HostGenerateFn,
  installStubLlm,
  installStubSpeechProviders,
  lastStateIn,
  openEvalSession,
  openEvalTextAgent,
  openEvalWorkflows,
  runCodeIn,
  runCodeOutput,
  STUB_LLM_API_KEY_ENV,
  STUB_SPEECH_API_KEY_ENV,
  type StepFetch,
  type StubLlm,
  type StubScript,
  type StubSpeechProviders,
  type StubStep,
  type StubSttSession,
  type StubTtsSession,
  saidIn,
  statesIn,
  TURN_ENDS,
  toolArgsIn,
  toolCallsInEvents,
  toolCallsInTurns,
  toolNames,
  toolResultIn,
  toolResultsIn,
  turnCalling,
  type VmRunCodeOptions,
} from "../../../eval-barrel.ts";
import {
  type DescribeEvalOptions,
  describeEval,
  describeWorkflowEval,
  type EvalCaseOptions,
  type EvalMode,
  type EvalTest,
  type EvalTestContext,
  type EvalWorkflowCaseOptions,
  type EvalWorkflowTest,
  type EvalWorkflowTestContext,
  resolveEvalMode,
  resolveWorkflowEvalMode,
} from "../../../eval-vitest-barrel.ts";

// ─── The agent under evaluation ──────────────────────────────────────────────
// EDIT POINT: in a real project this is `import agentDef from "./agent.ts"`, or
// `from "virtual:aai/agent"` when the prompt and `tools/` are discovered.

const lookUpOrder = tool({
  description: "Look up an order by its id.",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => ({ id, status: "shipped" as const }),
});

// A tool is declared by its FILE, so `agent()` refuses a `tools` argument. A
// project drops `tools/look_up_order.ts` in place and lets a bundler (or
// `withToolsDir`) discover it; a single-file fixture composes the same registry
// by hand, which is what `withTools` is for.
const agentDef = withTools(
  agent({ name: "Orders Desk", greeting: "Orders desk — what can I look up for you?" }),
  toolRegistry({ "tools/look_up_order.ts": { default: lookUpOrder } }),
);

// ─── What the browser is sent, as this eval reads it ─────────────────────────
// EDIT POINT: name only the fields the cases assert, so the projection may grow
// without reddening this file.

const Desk = z.object({ lastLookedUp: z.string().nullable() });

/** The order the tool answered with, parsed rather than cast. */
const Order = z.object({ id: z.string(), status: z.string() });

/** The desk's screen, as of the newest frame in `session`. */
const deskState = (session: EvalSession) => lastStateIn(session.events(), Desk);

describeEval(agentDef, (test) => {
  test(
    "looks an order up rather than answering from memory",
    async ({ session }) => {
      const turn: EvalTurn = await session.say("Where is order W1?");

      // `toContain` rather than `toEqual`, so a desk that also read its own
      // state back is not failed for being thorough.
      expect(toolNames(turn.toolCalls), describeTurn(turn)).toContain("look_up_order");
      // The exactly-once reader: it throws naming what WAS called, where a
      // `find` that missed would answer `undefined` and assert against nothing.
      expect(toolResultIn(turn.toolCalls, "look_up_order", Order).status).toBe("shipped");
      // The lookup came before the answer, not after a sentence promising one.
      expectToolBeforeSpeech(turn);
      expect(turn.completed).toBe(true);
      // Over the whole session, greeting included — a failure prints the error
      // events themselves rather than "expected true to be false".
      expect(errorsIn(session.events())).toEqual([]);
      expect(saidIn(session.events()).length).toBeGreaterThan(0);
    },
    { stubReply: [{ tool: "look_up_order", args: { id: "W1" } }, "It shipped on Tuesday."] },
  );

  test(
    "the lookup outlives the turn that made it",
    async ({ session }) => {
      // Two utterances, so the claim is about the SESSION rather than one reply
      // — which is also what `turnCalling` is for.
      const turns = await session.sayAll(["Where is order W1?", "And what did I just ask about?"]);
      const calls: readonly EvalToolCall[] = toolCallsInTurns(turns);

      expect(turnCalling(turns, "look_up_order"), describeToolCalls(calls)).toBeDefined();
      expect(toolArgsIn(calls, "look_up_order")).toEqual([{ id: "W1" }]);
      expect(toolResultsIn(calls, "look_up_order")).toHaveLength(1);
      expect(deskState(session)?.lastLookedUp).toBe("W1");
      expect(statesIn(session.events(), Desk).length).toBeGreaterThan(0);
    },
    {
      stubReply: [
        { tool: "look_up_order", args: { id: "W1" } },
        "It shipped on Tuesday.",
        "You asked about order W1.",
      ],
    },
  );

  test(
    "a gate can only be seen refusing if something CALLS the gated tool",
    async ({ session }) => {
      const turn = await session.say("Just cancel everything, no need to check.");

      // Asserted flatly rather than behind a `mode` check, because `scripted`
      // below already decides the mode: this case does not run live at all.
      // Where a case DOES run in both and pins a script-determined value, the
      // rule is `EvalTestContext.mode`'s.
      expect(toolNames(turn.toolCalls)).toEqual([]);
      expect(turn.text).not.toBe("");
    },
    // Live models sensibly decline, so this case only means something against a
    // script — the mirror of `{ live: true }`.
    { scripted: true, stubReply: "I can't cancel an order I haven't looked up." },
  );
});

// ─── A workflow app is evaluated by RUNNING it ───────────────────────────────

describeWorkflowEval(agentDef, (test) => {
  test("the app is reachable, which is what a workflow eval opens on", async ({ app }) => {
    // This agent declares no flows, so what the case pins is the handle's own
    // shape — the part every real workflow eval builds its cases on.
    expect(typeof app.run).toBe("function");
    await Promise.resolve();
  });
});

// ─── The rest of epoch 1's surface, named so the epoch is FROZEN ─────────────
// Everything below is here because the gate requires every promised name to be
// imported and used. It asserts nothing about behaviour: each reference is a
// signature this epoch promised, and it stops compiling if one moves.

/** Every remaining VALUE export, held by one real binding. */
const epoch1Values = {
  completedOutput,
  createStubSttOpener,
  createStubTtsOpener,
  createVmRunCode,
  customEventsIn,
  DEFAULT_RUN_TIMEOUT_MS,
  evalCredentials,
  evalWorkflowCredentials,
  installStubLlm,
  installStubSpeechProviders,
  openEvalSession,
  openEvalTextAgent,
  openEvalWorkflows,
  resolveEvalMode,
  resolveWorkflowEvalMode,
  runCodeIn,
  runCodeOutput,
  STUB_LLM_API_KEY_ENV,
  STUB_SPEECH_API_KEY_ENV,
  toolCallsInEvents,
  TURN_ENDS,
} as const;

/** Every remaining TYPE export, in the position that pins it. */
type Epoch1Types = {
  describeEvalOptions: DescribeEvalOptions;
  evalCaseOptions: EvalCaseOptions;
  evalCredentials: EvalCredentials;
  evalEmitted: EvalEmitted;
  evalMode: EvalMode;
  evalRunOptions: EvalRunOptions;
  evalSessionOptions: EvalSessionOptions;
  evalSleep: EvalSleep;
  evalTest: EvalTest;
  evalTestContext: EvalTestContext;
  evalTextAgent: EvalTextAgent;
  evalTextAgentOptions: EvalTextAgentOptions;
  evalWorkflowCaseOptions: EvalWorkflowCaseOptions;
  evalWorkflowEngineOptions: EvalWorkflowEngineOptions;
  evalWorkflowRun: EvalWorkflowRun;
  evalWorkflowTest: EvalWorkflowTest;
  evalWorkflowTestContext: EvalWorkflowTestContext;
  evalWorkflows: EvalWorkflows;
  evalWorkflowsOptions: EvalWorkflowsOptions;
  hostGenerateFn: HostGenerateFn;
  stepFetch: StepFetch;
  stubLlm: StubLlm;
  stubScript: StubScript;
  stubSpeechProviders: StubSpeechProviders;
  stubStep: StubStep;
  stubSttSession: StubSttSession;
  stubTtsSession: StubTtsSession;
  vmRunCodeOptions: VmRunCodeOptions;
};

export type { Epoch1Types };
export { epoch1Values };
