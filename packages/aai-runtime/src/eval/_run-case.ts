// Copyright 2026 the AAI authors. MIT license.
/**
 * One `describeEval` case, stood up and torn down: the scripted models, the
 * workflow engine, the network, and the session over all of them.
 *
 * Split out of `describe.ts` at the 500-line source cap, on the seam the file
 * already had — `describe.ts` DECLARES a suite (its mode, its coverage line,
 * its spread), this RUNS one case of it. The teardown is the reason it is
 * worth reading as one unit: every piece it opens owns a PROCESS-GLOBAL
 * registration or a live runtime, and the `finally` is the only thing that
 * gives them back.
 *
 * @module
 */

import type { AgentDef } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { createGenerateFn, GenerateSchemaMismatchError, type HostGenerateFn } from "../generate.ts";
import type { EvalMode } from "./_announce.ts";
import { hasWorkflows } from "./_declared-tools.ts";
import { type SuiteNetwork, stepFetchOver } from "./_network-install.ts";
import { noteTranscript } from "./_spread.ts";
import { stubbedEnv } from "./_stubbed-env.ts";
import type { DescribeEvalOptions, EvalCaseOptions, EvalTestContext } from "./describe.ts";
import { openEvalSessionWithSeams } from "./session.ts";
import { installStubLlm } from "./stub-llm.ts";
import { transcriptOf } from "./transcript.ts";
import { openEvalWorkflows } from "./workflows.ts";

/** What a stub-mode model says when a case scripts nothing. */
const DEFAULT_STUB_REPLY = "This is a scripted reply from the eval stub model.";

/** What one case needs to stand itself up. */
export type CaseRun = {
  readonly agent: AgentDef;
  readonly mode: EvalMode;
  readonly options: DescribeEvalOptions | undefined;
  readonly caseOptions: EvalCaseOptions | undefined;
  readonly body: (ctx: EvalTestContext) => Promise<void>;
  readonly net: SuiteNetwork;
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
export async function runCase(run: CaseRun): Promise<void> {
  const { agent, mode, options, caseOptions, body } = run;
  // First, so a conflicting option throws before anything is installed, and
  // per case AND per repeat, so no repeat reads another's requests.
  const net = caseNetwork(run);
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
          // The engine publishes this and unpublishes the slot on close; handed
          // the network's, a step's HTTP is routed or refused like a tool's.
          ...omitUndefined({ stepFetch: net?.stepFetch }),
        })
      : undefined;
  // The suite's identity comes OUT of the spread, so a case's `null` can
  // clear it: spreading it in and then overriding could only ever replace.
  const { clientId, phone, call, ...suite } = options ?? {};
  const session = await openEvalSessionWithSeams({
    ...suite,
    agent,
    ...omitUndefined({
      // The case's identity over the suite's, field by field: a case naming
      // only a `call` still runs as the suite's client.
      clientId: caseOrSuite(caseOptions?.clientId, clientId),
      phone: caseOrSuite(caseOptions?.phone, phone),
      call: caseOrSuite(caseOptions?.call, call),
      workflows: workflows?.client,
      // What the builtins take — the network, when there is one.
      fetch: net?.fetch,
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
    await body({ session, mode, workflows, network: net?.network });
  } catch (err) {
    // Taken NOW, before the close below adds its own events: this is the try
    // the `AAI_EVAL_REPEAT` summary prints under an UNSTABLE case.
    noteTranscript(err, transcriptOf(session, net?.network));
    throw err;
  } finally {
    await session.close();
    await workflows?.close();
    stub?.release();
    generateStub?.release();
    // Last: a hook the close set off may still be reaching for the network,
    // and is refused into this case's log rather than let out.
    if (net !== undefined) run.net.end();
  }
}

/**
 * One identity field for a case: `null` is "none", absent is the suite's.
 */
function caseOrSuite<T>(own: T | null | undefined, suite: T | undefined): T | undefined {
  if (own === null) return undefined;
  return own ?? suite;
}

/**
 * The case's network, aimed at by the suite's dispatcher — or `undefined`
 * when neither the case nor the suite passed one.
 *
 * @throws When a `fetch` or a `workflowOptions.stepFetch` was passed beside a
 *   network: each would answer the requests the network is there to answer,
 *   and which one won would be an accident of spread order.
 */
function caseNetwork(run: CaseRun) {
  const source = run.caseOptions?.network ?? run.options?.network;
  if (source === undefined) return;
  if (run.options?.fetch !== undefined || run.options?.workflowOptions?.stepFetch !== undefined) {
    throw new Error(
      "describeEval: `network` replaces `fetch` and `workflowOptions.stepFetch` — it answers " +
        "the builtins and a step's HTTP too. Pass one or the other, not both.",
    );
  }
  const { network, fetch } = run.net.begin(source);
  return { network, fetch, stepFetch: stepFetchOver(fetch) };
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
