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

import type { AgentDef } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, test } from "vitest";
import { createGenerateFn, GenerateSchemaMismatchError, type HostGenerateFn } from "../generate.ts";
import {
  announceEvalCoverage,
  announceEvalMode,
  type EvalMode,
  registerEmptySuiteFailure,
} from "./_announce.ts";
import { announceToollessAgent, checkStubReplyTools, hasWorkflows } from "./_declared-tools.ts";
import { evalOnlySelects, evalRepeat } from "./_env.ts";
import { runRepeats, SuiteSpread } from "./_spread.ts";
import { stubbedEnv } from "./_stubbed-env.ts";
import { resolveEvalMode } from "./eval-mode.ts";
import { type EvalSession, type EvalSessionOptions, openEvalSession } from "./session.ts";
import { installStubLlm, type StubScript } from "./stub-llm.ts";
import { type EvalWorkflows, type EvalWorkflowsOptions, openEvalWorkflows } from "./workflows.ts";

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
};

// `EvalMode` is DECLARED in `_announce.ts`, beside the three functions that
// report a suite's mode and its case counts, and re-exported here because it is
// on this package's `/eval/vitest` barrel — moving a published name to a new
// file must not move where a reader imports it from. The three functions are
// not re-exported: their callers name that module directly.
export type { EvalMode } from "./_announce.ts";

/** What a case body is handed: its own session, and which model it is on. */
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
export type EvalTest = (
  name: string,
  body: (ctx: EvalTestContext) => Promise<void>,
  options?: EvalCaseOptions,
) => void;

/** What a stub-mode model says when a case scripts nothing. */
const DEFAULT_STUB_REPLY = "This is a scripted reply from the eval stub model.";

/**
 * Declare an eval suite for `agent`.
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
export function describeEval(
  agent: AgentDef,
  define: (test: EvalTest) => void,
  options?: DescribeEvalOptions,
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

  describe(agent.name, () => {
    let declared = 0;
    let skippedCases = 0;
    // Counted SEPARATELY from the mode skips, because the two mean different
    // things and the coverage line reports the reason. A case dropped by
    // `AAI_EVAL_ONLY` is not "live-only", and saying so was this filter's first
    // bug: `AAI_EVAL_ONLY=nonexistent` announced "2 skipped as live-only" about
    // two cases that carried no marker at all.
    const filteredOut: string[] = [];
    const evalTest: EvalTest = (name, body, caseOptions) => {
      checkStubReplyTools(agent, name, caseOptions?.stubReply);
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
          () => runCase({ agent, mode, options, caseOptions, body }),
          name,
          repeat,
          spread,
        ),
      );
    };
    define(evalTest);
    announceEvalCoverage(agent.name, mode, declared, skippedCases, filteredOut.length);
    // A FILTERED run has opted out of coverage on purpose, so the empty-suite
    // failure is not its business — and must not be. `AAI_EVAL_ONLY` is one
    // variable across the whole tier while each suite sees only its own cases,
    // so a filter aimed at one template would otherwise fail the other
    // twenty-seven for not containing it. `aai-evals/_register.ts` reached the
    // same conclusion for the same reason and warns instead; this warns too.
    if (declared > 0 && filteredOut.length === declared) {
      announceEvalMode(
        `eval: ${agent.name} — AAI_EVAL_ONLY matched none of its ${declared} case(s), so this ` +
          `suite ran nothing. Its cases are: ${filteredOut
            .map((one) => JSON.stringify(one))
            .join(", ")}.`,
      );
    } else {
      registerEmptySuiteFailure(agent.name, mode, declared - filteredOut.length, skippedCases);
    }
    spread.report();
  });
}

/** What one case needs to stand itself up. */
type CaseRun = {
  readonly agent: AgentDef;
  readonly mode: EvalMode;
  readonly options: DescribeEvalOptions | undefined;
  readonly caseOptions: EvalCaseOptions | undefined;
  readonly body: (ctx: EvalTestContext) => Promise<void>;
};

/**
 * Open everything one case needs, run its body, and close in reverse.
 *
 * Its own function rather than an arrow inside `describeEval`, because the four
 * things a case may need — a scripted turn model, a scripted `ctx.generate`, a
 * workflow engine, the session over all three — put that arrow past Biome's
 * complexity ceiling. The teardown is the reason it is worth reading as one
 * unit: every one of those four owns a PROCESS-GLOBAL registration or a live
 * runtime, and the `finally` is the only thing that gives them back.
 */
async function runCase(run: CaseRun): Promise<void> {
  const { agent, mode, options, caseOptions, body } = run;
  const stub =
    mode === "stub" ? installStubLlm(caseOptions?.stubReply ?? DEFAULT_STUB_REPLY) : undefined;
  // Its own kind, so its own cursor: see `EvalCaseOptions.stubGenerate`.
  const generateStub =
    mode === "stub" && caseOptions?.stubGenerate !== undefined
      ? installStubLlm(caseOptions.stubGenerate)
      : undefined;
  // Opened BEFORE the session, because the session is handed its client. Only
  // for an agent that declares workflows, and only when the suite did not supply
  // a client of its own — a caller who passed one owns it.
  const workflows =
    options?.workflows === undefined && hasWorkflows(agent)
      ? openEvalWorkflows({
          agent,
          // The same env `describeWorkflowEval` gives a workflow app: in stub
          // mode a declared key nobody has is a placeholder, so a step's
          // `requireStepEnv` reaches the scripted provider instead of throwing
          // over a credential the case was never going to use.
          env: options?.env ?? stubbedEnv(agent, mode),
          ...(options?.workflowOptions ?? {}),
        })
      : undefined;
  const session = await openEvalSession({
    ...options,
    agent,
    ...omitUndefined({
      workflows: workflows?.client,
      // The scripted `ctx.generate`, which the runtime would otherwise build
      // from the agent's own descriptor — a second instance of the TURN's
      // model, walking that script from the start.
      generate:
        generateStub === undefined
          ? undefined
          : checkedGenerate(createGenerateFn({ llm: generateStub.llm, env: generateStub.env })),
    }),
    ...(stub === undefined
      ? {}
      : { llm: stub.llm, providerEnv: { ...options?.providerEnv, ...stub.env } }),
  });
  try {
    await body({ session, mode, workflows });
  } finally {
    await session.close();
    await workflows?.close();
    stub?.release();
    generateStub?.release();
  }
}

/**
 * Re-attribute a schema rejection from THE MODEL to THE SCRIPT.
 *
 * `ctx.generate({ schema })` used to hand back whatever parsed, typed as
 * whatever the schema said — a script of `{"issues":"not-an-array"}` against
 * `z.object({ issues: z.array(z.string()) })` resolved, and a case asserting on
 * `issues.length` read `13`. This wrapper caught that, and its own doc said the
 * real fix belonged in `ctx.generate`. It now lives there
 * ({@link GenerateSchemaMismatchError}), so the checking half of this is gone.
 *
 * What is left is the half only the harness can do. `createGenerateFn`'s message
 * blames "the model", which is right in production and wrong here: an eval's
 * model is a script the case author wrote, against a schema the tool declares
 * one file away, so the actionable sentence names the script rather than the
 * agent. A live model's invalid output is a finding about the model; a SCRIPT's
 * is a finding about the script — which is why this is only ever put on
 * `stubGenerate`.
 *
 * It no longer quotes the script back: the throw now happens inside `generate`,
 * so there is no answer to read `text` off. The issues themselves ride along in
 * the cause's message, which is the part that says what to change.
 */
function checkedGenerate(generate: HostGenerateFn): HostGenerateFn {
  return async (options, callOptions) => {
    try {
      return await generate(options, callOptions);
    } catch (cause) {
      if (!(cause instanceof GenerateSchemaMismatchError)) throw cause;
      throw new Error(
        `stubGenerate answered something the call's own schema rejects. ${cause.message} — ` +
          "write the script as the JSON the model would have returned, matching the schema " +
          "the tool declares, or the case is measuring the script rather than the agent.",
        { cause },
      );
    }
  };
}
