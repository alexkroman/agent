// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:eval` epoch 3.
 *
 * An eval file as a TEMPLATE author writes one — which is what this capability
 * is for. Its consumers do not implement anything here; they CALL
 * `describeEval`, drive turns with `say()`, and read the run back through the
 * event readers. So this is the caller side, written the way it was authored at
 * epoch 3, and it must keep compiling for as long as that epoch is advertised as
 * supported.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * Epoch 4 ADDED five names — `toolNames` and `describeToolCalls` on the readers,
 * `describeTurn`, `callsIn` and `turnCalling` over a sequence of turns — plus one
 * method, `EvalSession.sayAll`. Every one of them was hand-rolled in the shipped
 * template evals first, several byte-identically, which is what said they were
 * the harness's concepts rather than any template's.
 *
 * Nothing in epoch 3 stops compiling, which is what makes this a retain: an
 * export ADDED to a subpath breaks no importer, and a method added to a type an
 * eval CONSUMES breaks no call site. The file below still spells the three
 * hand-rolled readers out longhand, which is exactly how an epoch-3 eval was
 * written, and it is deliberately left that way — an epoch example that adopted
 * the newer names would stop being an epoch-3 example.
 *
 * **The direction that WOULD break is a name coming OFF `/eval` or `/eval/vitest`,
 * or a signature narrowing under one of the calls below** — `say()` no longer
 * answering an `EvalTurn`, `toolResultIn` demanding a schema, `EvalTestContext`
 * losing `workflows`, `completedOutput` taking something other than a run. Each
 * reddens this file immediately, which is the whole reason the CALLER side is the
 * one worth freezing for a capability nobody implements.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 3 has to be dropped with a reason.
 */

import { agent, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import {
  completedOutput,
  createVmRunCode,
  customEventsIn,
  type EvalToolCall,
  type EvalTurn,
  type EvalWorkflowRun,
  evalCredentials,
  evalWorkflowCredentials,
  installStubLlm,
  lastStateIn,
  openEvalSession,
  openEvalWorkflows,
  saidIn,
  statesIn,
  TURN_ENDS,
  toolArgsIn,
  toolCallsIn,
  toolResultIn,
  toolResultsIn,
} from "../../../eval-barrel.ts";
import {
  describeEval,
  describeWorkflowEval,
  type EvalMode,
  resolveEvalMode,
} from "../../../eval-vitest-barrel.ts";

/**
 * ── EDIT: your own agent. ────────────────────────────────────────────────
 *
 * Declared inline so the example needs no `agent.ts` beside it; a real eval
 * imports the agent under test (`import agentDef from "./agent.ts"`, or
 * `virtual:aai/agent` in a template).
 */
const agentDef = agent({
  name: "Order Desk",
  systemPrompt: "Help the caller with an order. Confirm before changing anything.",
  greeting: "Order desk — how can I help?",
});

/** What the agent pushes to the page, for the state readers below. */
const ProjectedOrder = z.object({ reference: z.string(), placed: z.boolean() });

/** The digest a workflow app returns, for the workflow half. */
const digest = workflow({
  description: "Summarize an order",
  input: z.object({ reference: z.string() }),
  run: (input: { reference: string }) => ({ headline: `order ${input.reference}` }),
});

const workflowApp = agent({
  name: "Order Digest",
  page: "static",
  workflows: { digest },
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});

/** No runner in an authoring example — a case's own claim, spelled out. */
function insist(ok: boolean, why: string): void {
  if (!ok) throw new Error(why);
}

/**
 * ── The three readers epoch 3 had no export for. ─────────────────────────
 *
 * Frozen as they were written: every shipped eval carried some spelling of
 * these, which is what epoch 4's `toolNames`, `callsIn` and `turnCalling`
 * replaced. Left longhand on purpose — see the module doc.
 */
const named = (calls: readonly EvalToolCall[]): string[] => calls.map((call) => call.name);
const allCalls = (turns: readonly EvalTurn[]): readonly EvalToolCall[] =>
  turns.flatMap((turn) => turn.toolCalls);
const turnWith = (turns: readonly EvalTurn[], tool: string): EvalTurn | undefined =>
  turns.find((turn) => turn.toolCalls.some((call) => call.name === tool));

/** The suite, as `describeEval` registers one. */
export function registerVoiceCases(): void {
  describeEval(
    agentDef,
    (test) => {
      test(
        "stages a change and reads it back before committing",
        async ({ session, mode, workflows }) => {
          const mode3: EvalMode = mode;
          insist(mode3 === "live" || mode3 === "stub", "a case is told which model it got");
          insist(workflows === undefined || workflows.client !== undefined, "the workflow seam");

          // Driven one line at a time — epoch 3 had no `sayAll`.
          const turns: EvalTurn[] = [];
          for (const line of ["I want to cancel order W1234", "Yes, go ahead"]) {
            turns.push(await session.say(line));
          }

          const staging = turnWith(turns, "stage_cancellation");
          insist(
            staging !== undefined,
            `tools called: [${named(allCalls(turns)).join(", ")}]; said: ${turns.at(-1)?.text}`,
          );
          insist(staging?.completed === true, "the staging reply was not cancelled");

          // The readers, over one turn and over the whole call.
          const calls = toolCallsIn(staging?.events ?? []);
          insist(named(calls).includes("stage_cancellation"), "the staged call is on that turn");
          const args = toolArgsIn(calls, "stage_cancellation", z.object({ reference: z.string() }));
          insist(args[0]?.reference === "W1234", "the reference the caller gave");
          const result = toolResultIn(calls, "stage_cancellation", z.object({ state: z.string() }));
          insist(result.state === "awaitingConfirmation", "staged, not committed");
          insist(
            toolResultsIn(session.toolCalls(), "stage_cancellation").length > 0,
            "at least one",
          );

          // What the caller was told, and what the page was shown.
          insist(saidIn(session.events()).length >= 2, "the greeting is a real turn");
          insist(session.said().length >= 2, "and it is in the run-wide view");
          const view = lastStateIn(session.events(), ProjectedOrder);
          insist(view?.reference === "W1234", "the page shows the order");
          insist(statesIn(session.events(), ProjectedOrder).length > 0, "at least one frame");
          insist(customEventsIn(session.events(), "wind_down").length === 0, "no nudge yet");
          insist(TURN_ENDS.has("reply.completed"), "the terminator set is published");
        },
        { stubReply: [{ tool: "stage_cancellation", args: { reference: "W1234" } }, "Staged."] },
      );
    },
    // The four seams a case fills, all reachable at epoch 3.
    {
      env: { ORDER_API_BASE: "https://orders.example.test" },
      runCode: createVmRunCode({ timeoutMs: 2000 }),
      fetch: () => Promise.resolve(new Response("{}")),
      toolTimeoutMs: 60_000,
    },
  );
}

/** The workflow half of the same capability. */
export function registerWorkflowCases(): void {
  describeWorkflowEval(workflowApp, (test) => {
    test("digests an order and narrates on the way", async ({ app, mode }) => {
      insist(mode === "live" || mode === "stub", "a workflow case is told its mode too");
      const run: EvalWorkflowRun<{ headline: string }> = await app.run(
        digest,
        { reference: "W1234" },
        { key: "caller-42", timeoutMs: 30_000 },
      );
      const output = completedOutput(run);
      insist(output.headline.includes("W1234"), "the body's own return value");
      insist(run.key === "caller-42", "the correlation key the caller named");
      insist(run.slept.length === 0, "no durable wait was asked for");
      insist(run.emitted.length === 0, "and nothing was emitted");

      // Every run this app started, and one of them settled by id.
      const all = await app.runs();
      insist(all.length > 0, "the app remembers what it started");
      const again = await app.settle(run.runId, digest);
      insist(again.completed, "settling a run twice is the same answer");
    });
  });
}

/** The credential gates, which decide whether either suite measures anything. */
export function gates(): { voice: boolean; workflows: boolean; mode: EvalMode } {
  return {
    voice: evalCredentials(agentDef, { ASSEMBLYAI_API_KEY: "k" }).ready,
    workflows: evalWorkflowCredentials(workflowApp, { ASSEMBLYAI_API_KEY: "k" }).ready,
    mode: resolveEvalMode(agentDef).mode,
  };
}

/**
 * The same drive with no vitest suite around it — a harness of your own.
 *
 * `describeEval` is a convenience over exactly this, and both doors are part of
 * the promise: the driving half stays runner-agnostic, which is why
 * `openEvalSession` and `openEvalWorkflows` are on `/eval` and the suite is on
 * `/eval/vitest`.
 */
export async function runWithoutVitest(): Promise<readonly string[]> {
  const stub = installStubLlm([
    { tool: "stage_cancellation", args: { reference: "W1234" } },
    "Staged.",
  ]);
  const app = openEvalWorkflows({ agent: workflowApp, env: { ASSEMBLYAI_API_KEY: "k" } });
  const session = await openEvalSession({
    agent: agentDef,
    llm: stub.llm,
    providerEnv: stub.env,
    // The seam that makes a run-starting tool executable at all.
    workflows: app.client,
  });
  try {
    const turn: EvalTurn = await session.say("cancel order W1234");
    insist(named(turn.toolCalls).length >= 0, "a turn carries its calls");
    return session.said();
  } finally {
    await session.close();
    await app.close();
    stub.release();
  }
}
