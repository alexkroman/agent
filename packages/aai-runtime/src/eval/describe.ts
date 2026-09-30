// Copyright 2026 the AAI authors. MIT license.
/**
 * `describeEval` — a gated eval suite, with the session and the mode handled.
 *
 * Every eval file opens with the same three decisions, and each of them is easy
 * to get quietly wrong:
 *
 * 1. **Is there a key?** Without one a live case cannot run, and a suite that
 *    fails for want of a credential says nothing about the agent.
 * 2. **What does a run with no key still prove?** Rather than skipping, the
 *    suite runs against a SCRIPTED model (`stub-llm.ts`): the real runtime, the
 *    real pipeline, the real tools, a fake reply. That is a wiring check and it
 *    is worth having in a pipeline, which cannot have a key.
 * 3. **Which mode did I just get?** Announced, once, on every run. The one
 *    outcome this module refuses to produce is a green suite whose reader
 *    cannot tell which of the two it was.
 *
 * Plus the per-case bookkeeping: one session per case, opened before the body
 * and closed after it whatever happens, so the body is the assertions and
 * nothing else.
 *
 * This lives on `@alexkroman1/aai-runtime/eval/vitest` rather than beside
 * `openEvalSession`, on the repo's standing rule: anything that INSTALLS and
 * anything that RESTORES belongs on the subpath that pulls the test runner.
 * `vitest` is an optional peer, so importing that subpath is what asks for it.
 *
 * @module
 */

import type { AgentDef, SessionCall } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import { afterAll, beforeAll, describe, test } from "vitest";
import { announceEvalMode, closeEvalSuite, type EvalMode } from "./_announce.ts";
import { announceToollessAgent, checkStubReplyTools } from "./_declared-tools.ts";
import { evalOnlySelects, evalRepeat } from "./_env.ts";
import { suiteNetwork, wantsNetwork } from "./_network-install.ts";
import { runCase } from "./_run-case.ts";
import { runRepeats, SuiteSpread } from "./_spread.ts";
import { resolveEvalMode } from "./eval-mode.ts";
import type { EvalNetwork } from "./network.ts";
import type { EvalSession, EvalSessionOptions } from "./session.ts";
import type { StubScript } from "./stub-llm.ts";
import type { EvalWorkflows, EvalWorkflowsOptions } from "./workflows.ts";

/** What a case gets to say about how it should be run. */
export type EvalCaseOptions = {
  /**
   * What a SCRIPTED model does when this suite runs without a key — one entry
   * per model call, the last line repeating. A string is a line the agent says;
   * `{ tool, args }` is a tool call, which is what makes a stub run worth having
   * for an agent that HAS tools:
   *
   * `no-check`: the fence is one FIELD of this type, and its only compilable
   * reading is a labelled statement inside a block — it would type-check
   * whatever the field were called, so checking it asserts nothing about
   * {@link EvalCaseOptions.stubReply}. Kept as a fragment deliberately, not
   * because it cannot compile: a `no-check` that would pass is unclaimed
   * headroom, and this one would pass for the wrong reason.
   *
   * ```ts no-check
   * { stubReply: [{ tool: "look_up", args: { orderId: "W1234" } }, "It shipped."] }
   * ```
   *
   * Choose it so the case's own assertions still hold: the point of a stub run
   * is that the case really executes, and a stub the case then fails against
   * measures nothing.
   */
  readonly stubReply?: StubScript;
  /**
   * What a SCRIPTED `ctx.generate` answers with — its OWN script, walked by its
   * own cursor.
   *
   * Separate from {@link EvalCaseOptions.stubReply} because `ctx.generate`
   * resolves a model INSTANCE of its own, in parallel with the turn's: one
   * script would need element 0 to be the turn's first move and the first
   * `generate` answer simultaneously. A tool that reasons with a model — a
   * grader, a planner, a rewriter — is the shape this exists for, and two
   * shipped templates' central tools are exactly that. For the schema overload,
   * write the object as the JSON string the model would have returned.
   */
  readonly stubGenerate?: StubScript;
  /**
   * This case only means something against a live model — it is SKIPPED in stub
   * mode. Use it for a claim no script can honestly satisfy: a tool the model
   * has to choose for itself, a refusal, a judgement.
   */
  readonly live?: boolean;
  /**
   * The mirror: this case only means something against a SCRIPT, and is skipped
   * against a live model.
   *
   * It is not a symmetry for its own sake — three cases needed it. A gate can
   * only be observed refusing if something CALLS the gated tool, and a competent
   * model declines to (measured: `tabletop-rpg-agent`'s game-over route is a tool its own
   * prompt forbids unprompted; a dispatcher calls `resources_get_available`
   * first and never trips the busy-unit refusal; a `visit_webpage` at a private
   * address is the SSRF screen's own case and a live model sensibly refuses to
   * try). Without this marker each cost a red live run and got weakened.
   */
  readonly scripted?: boolean;
  /**
   * WHO this case's session is, over the suite's own
   * ({@link DescribeEvalOptions}) — the client id `sessionClientId(ctx)`
   * answers. See `EvalSessionOptions.clientId`. `null` is "no client id for
   * this case", whatever the suite set; absent is "the suite's".
   *
   * Per case because a suite's cases are rarely all the same caller: a
   * speaker agent's "a device with no client id is refused" case sits beside
   * twenty that run as the kitchen speaker, and it is written
   * `{ clientId: null }`.
   */
  readonly clientId?: string | null;
  /**
   * This case's reported phone number, over the suite's. See
   * `EvalSessionOptions.phone`. `null` is "no number for this case".
   */
  readonly phone?: string | null;
  /**
   * This case's placed phone call, over the suite's — what `sessionContext`
   * receives as `call`. See `EvalSessionOptions.call`; a call the hook refuses
   * lands on `session.refused`. `null` is "not a placed call": a calling
   * agent's refusal of a session no carrier started, inside a suite whose
   * other cases are all the one call.
   */
  readonly call?: SessionCall | null;
  /**
   * This case's fake network, over the suite's — see
   * `DescribeEvalOptions.network`. A case needing routes of its own (a
   * service that answers differently in this one scenario) passes them here.
   */
  readonly network?: EvalNetwork | (() => EvalNetwork);
};

// `EvalMode` is DECLARED in `_announce.ts`, beside the three functions that
// report a suite's mode and its case counts, and re-exported here because it is
// on this package's `/eval/vitest` barrel — moving a published name to a new
// file must not move where a reader imports it from. The three functions are
// not re-exported: their callers name that module directly.
export type { EvalMode } from "./_announce.ts";

/**
 * What a case body is handed: its own session, which model it is on, and the
 * workflow app behind it.
 *
 * A simulated caller and a model-graded judge are NOT on it: a case that wants
 * them builds the pair from `session` and `mode` with `evalSimulation` on
 * `@alexkroman1/aai-runtime/eval/simulate`, a surface versioned on its own.
 *
 * @sealed
 */
export type EvalTestContext = {
  /** Open for this case, closed after it. */
  readonly session: EvalSession;
  /**
   * Which model this run got. A case may branch on it, and most should not.
   *
   * ## The one branch that is always right
   *
   * **A value a SCRIPT determined may only be asserted under
   * `mode === "stub"`.** `stubReply` and `stubGenerate` are what make a value
   * predictable, so pinning one against a live model is pinning the script — and
   * it presents as the agent misbehaving, which is the expensive part. Three
   * shipped template evals had it, and each read as a defect in the template
   * until the script was checked:
   *
   * - `word-game-agent` asserted `playerSaid: "Is it a zebra crossing?"`, the
   *   exact remark of a scripted player, in a game whose word is drawn at
   *   random. Live, "Is it a zebra?" is a perfectly good wrong guess.
   * - `executive-inbox-agent` pinned `2 closed / 6 queued`, a split decided by
   *   eight live triage verdicts. A run that found every email worth answering
   *   failed on "expected [] to have a length of 2".
   * - `topic-briefing-agent` required a verdict word from a subagent its own
   *   tool documents as allowed to come back unusable.
   *
   * So: assert the INVARIANT in both modes — the tool was called, the verdict
   * and the score agree, nothing was sent before a yes — and put the exact
   * strings behind the branch.
   *
   * ```ts no-check
   * test("a wrong guess is relayed without a point", async ({ session, mode }) => {
   *   const relayed = await play(session);
   *   // True either way: the player answered and the round stands.
   *   expect(relayed.playerSaid.length).toBeGreaterThan(0);
   *   if (relayed.verdict === "wrong") expect(relayed.score).toBe(0);
   *   // Only a script can pin the words.
   *   if (mode === "stub") expect(relayed.playerSaid).toBe("Is it a zebra crossing?");
   * });
   * ```
   *
   * A case that cannot be written that way wants `{ scripted: true }` instead,
   * which skips it live rather than weakening it — see
   * {@link EvalCaseOptions.scripted}.
   */
  readonly mode: EvalMode;
  /**
   * The workflow app behind this session's `ctx.workflows`, for an agent that
   * declares workflows — `undefined` for one that does not.
   *
   * Opened per case and closed after it, and it is what makes a tool calling
   * `ctx.workflows.start` runnable at all: the real client the runtime would
   * build cannot start an untransformed body. A case reads the run its tool
   * started with `workflows.settle(runId)`.
   *
   * The engine under it is NOT durable — see `eval/workflow-engine.ts` before
   * writing a claim about a run.
   */
  readonly workflows: EvalWorkflows | undefined;
  /**
   * The client this session's `ctx.workflows` IS: the suite's own
   * (`describeEval`'s `workflows` — the one its factory built for THIS case
   * and repeat), else the engine's `workflows.client`, else
   * `undefined` for an agent that declares no workflows and was given none.
   *
   * Typed by what the suite passed, in the body a case hands
   * {@link EvalTest}: a suite whose factory returns a recording client —
   * `() => createRecordingWorkflows({ workflows: agentDef.workflows })` from
   * `@alexkroman1/aai/testing`, which records every start and runs nothing —
   * reads `workflowClient.started("remind")` and seeds the runs `find`
   * answers with `workflowClient.seed(...)`, typed, with no module-level log
   * to reset.
   */
  readonly workflowClient: WorkflowClient | undefined;
  /**
   * The fake network every `fetch` of this case went through. Its log holds
   * THIS case's requests (THIS repeat's, under `AAI_EVAL_REPEAT`), so a case
   * asserts on `network.calls("textbelt.com")` or
   * `network.expectNoOutbound(/twilio/)` without filtering out another run's
   * traffic, and reads its routes' `network.state`.
   *
   * TYPED BY WHAT WAS PASSED, in the body a case hands {@link EvalTest}: in
   * a suite given `network` it is exactly that network's type —
   * `EvalNetwork<{ calls: Map<…> }>` for one built with `state` — so there is
   * no `undefined` to guard and no cast to reach the state. A case's own
   * `network` must be of the suite's type, so the type holds for it too. In a
   * suite given none it is `EvalNetwork | undefined` (this declaration) —
   * `undefined` at runtime unless the case passed one.
   */
  readonly network: EvalNetwork | undefined;
};

/**
 * What {@link describeEval} takes beyond the agent.
 *
 * The session options, plus `workflowOptions` for the engine it opens per case
 * when the agent declares `workflows`. That second one is not symmetry for its
 * own sake: a workflow-starting tool's STEPS make provider calls, and the only
 * honest way to evaluate which tool the desk reached for — without paying for
 * five gateway calls and a real web search per case, and without a 429 failing
 * the run outright because a step's `maxRetries` is inert here — is to script
 * the step's HTTP while leaving the SESSION's model live. Both templates that
 * hand off to a run had to install that inside the case body, which worked only
 * because the engine publishes nothing when nobody passed one.
 */
export type DescribeEvalOptions = Omit<EvalSessionOptions, "agent"> & {
  readonly workflowOptions?: Omit<EvalWorkflowsOptions, "agent">;
  /**
   * A fake network for every case — an `evalNetwork(...)`, or a FACTORY
   * returning one, called afresh for every case and every `AAI_EVAL_REPEAT`
   * repeat.
   *
   * It becomes all three fetches a case's code can reach: the global `fetch`
   * a custom tool calls, the `fetch` the builtins take, and the step fetch a
   * workflow step (or `sendToChannel`) reads. A request no route answers is
   * REFUSED and logged; only the live model's own provider hosts pass through,
   * worked out from the agent's `llm` (in a scripted run, not even those).
   * The global is swapped for the whole SUITE rather than per case, so an
   * `onSessionEnd` still running after a case closed (the session waits 10
   * seconds for it, then stops waiting) is refused into that case's log
   * rather than reaching the real network.
   *
   * Keep a route's STATE (rows a fake database holds) in the network's own
   * `state` (`evalNetwork({ state, routes })`): an instance's log AND state are
   * rebuilt per case and per repeat, and the case reads it, typed, as
   * `ctx.network.state`. State a handler keeps in its closure is not reset —
   * use a factory for that — and state carried from one repeat into the next
   * makes the second repeat measure the first. Mutually exclusive with
   * `fetch`, which it replaces.
   */
  readonly network?: EvalNetwork | (() => EvalNetwork);
};

/**
 * Declare one eval case. The session is opened for it and closed after it.
 *
 * Two things about this signature are decided by a LINTER rather than by
 * taste, both A/B'd against Biome 2.5 and both invisible until a user's own
 * project lights up red on a file the SDK told them to write:
 *
 * - **The parameter is named `test`.** `noMisplacedAssertion` matches on the
 *   CALLEE IDENTIFIER and nothing else, so an `expect` inside `evalTest(…)` is
 *   an error while the identical body inside `test(…)` is fine.
 * - **The body takes a DESTRUCTURED context, not the session positionally.**
 *   `noDoneCallback` reads the first parameter of an async test callback as
 *   jest's `done`, so `async (session) => …` is an error; `async ({ session })
 *   => …` is not — and it is vitest's own fixture shape, which is what a reader
 *   already expects.
 */
export type EvalTest<Network extends EvalNetwork = never, Client extends WorkflowClient = never> = (
  name: string,
  // Intersections rather than type parameters on `EvalTestContext`, which
  // stays one sealed shape for every suite: the network and the workflow
  // client are the fields whose types depend on the suite's options. `never`
  // (the default, nobody writes it) is a suite given none — tuple-wrapped so
  // it does not distribute to `never` — and `& unknown` is no change at all.
  body: (
    ctx: EvalTestContext &
      ([Network] extends [never] ? unknown : { readonly network: Network }) &
      ([Client] extends [never] ? unknown : { readonly workflowClient: Client }),
  ) => Promise<void>,
  options?: [Network] extends [never]
    ? EvalCaseOptions
    : Omit<EvalCaseOptions, "network"> & {
        /**
         * This case's own network, over the suite's — of the SUITE's network
         * type, so `ctx.network` stays true to its type (a different `state`
         * shape belongs in a suite of its own).
         */
        readonly network?: Network | (() => Network);
      },
) => void;

/**
 * Declare an eval suite for `agent`.
 *
 * Generic over the suite's `network` and `workflows` only so a case's
 * `ctx.network` and `ctx.workflowClient` are typed by them (see
 * {@link EvalTestContext.network}); nobody writes the type arguments, they
 * are read off `options`.
 *
 * ```ts no-check
 * describeEval(agentDef, (test) => {
 *   test(
 *     "offers to take an order",
 *     async ({ session }) => {
 *       const turn = await session.say("hi, what can you do?");
 *       expect(turn.text).toMatch(/order/i);
 *     },
 *     { stubReply: "I can take an order for you." },
 *   );
 * });
 * ```
 */
export function describeEval<
  Network extends EvalNetwork = never,
  Client extends WorkflowClient = never,
>(
  agent: AgentDef,
  define: (test: EvalTest<Network, Client>) => void,
  options?: Omit<DescribeEvalOptions, "network" | "workflows"> & {
    readonly network?: Network | (() => Network);
    /**
     * The `ctx.workflows` every case's session gets, in place of the eval
     * engine `describeEval` otherwise opens for an agent that declares
     * workflows — a `WorkflowClient`, or a FACTORY returning one, called afresh
     * for every case and every `AAI_EVAL_REPEAT` repeat, exactly as `network`'s
     * is. The case reads the live one as `ctx.workflowClient`.
     *
     * Prefer the factory for a client that RECORDS (`createRecordingWorkflows`
     * on `@alexkroman1/aai/testing`): an instance's log is its own, and
     * one carried into the next repeat makes the second measure the first — the
     * log a downstream suite reset by hand at the top of every case.
     *
     * Wider here than on {@link DescribeEvalOptions} (an instance), because
     * widening a published option type to a union breaks code that READS it.
     */
    readonly workflows?: Client | (() => Client) | undefined;
  },
): void {
  const { mode, reason } = resolveEvalMode(
    agent,
    process.env,
    omitUndefined({ llm: options?.llm }),
  );
  announceEvalMode(
    mode === "live"
      ? `eval: ${agent.name} — LIVE model (${reason}). This spends tokens.`
      : `eval: ${agent.name} — SCRIPTED model (${reason}). This checks the wiring, not the agent's behaviour.`,
  );
  announceToollessAgent(agent);

  // Both default to "everything, once", so an unset environment runs exactly
  // what it ran before this was wired up. See `_env.ts` for what was silently
  // ignored until it was.
  const repeat = evalRepeat();
  const spread = new SuiteSpread(agent.name);
  // Built up front, installed only if the suite or a case asks for one — see
  // `_network-install.ts` for why the SUITE owns the global.
  const net = suiteNetwork(mode, [agent.llm, options?.llm]);
  const caseOptionsSeen: (EvalCaseOptions | undefined)[] = [];

  describe(agent.name, () => {
    let declared = 0;
    let skippedCases = 0;
    // Counted SEPARATELY from the mode skips, because the two mean different
    // things and the coverage line reports the reason. A case dropped by
    // `AAI_EVAL_ONLY` is not "live-only", and saying so was this filter's first
    // bug: `AAI_EVAL_ONLY=nonexistent` announced "2 skipped as live-only" about
    // two cases that carried no marker at all.
    const filteredOut: string[] = [];
    // Typed loosely INSIDE: the context's network type is a promise about
    // what the caller passed, and `runCase` keeps it — the network it hands
    // the body is the one `options` (or the case) named.
    const evalTest = ((
      name: string,
      body: (ctx: EvalTestContext) => Promise<void>,
      caseOptions?: EvalCaseOptions,
    ): void => {
      checkStubReplyTools(agent, name, caseOptions?.stubReply);
      caseOptionsSeen.push(caseOptions);
      declared += 1;
      const wrongMode =
        (mode === "stub" && caseOptions?.live === true) ||
        (mode === "live" && caseOptions?.scripted === true);
      const filtered = !(wrongMode || evalOnlySelects(name));
      if (wrongMode) skippedCases += 1;
      if (filtered) filteredOut.push(name);
      const run = wrongMode || filtered ? test.skip : test;
      run(name, () =>
        runRepeats(
          () => runCase({ agent, mode, options, caseOptions, body, net }),
          name,
          repeat,
          spread,
        ),
      );
    }) as EvalTest<Network, Client>;
    define(evalTest);
    if (wantsNetwork(options?.network, caseOptionsSeen)) {
      beforeAll(() => net.install());
      afterAll(() => net.restore());
    }
    // Coverage line, then the empty-suite failure or the filtered-to-nothing
    // warning — see `closeEvalSuite` for why a filtered run only warns.
    closeEvalSuite(agent.name, mode, declared, skippedCases, filteredOut);
    spread.report();
  });
}
