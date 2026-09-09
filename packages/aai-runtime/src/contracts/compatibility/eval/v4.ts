// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:eval` epoch 4.
 *
 * This must keep compiling against current source for as long as epoch 4 is
 * advertised as supported. Editing it to make an error go away defeats the
 * mechanism — the error IS the finding, and the answer is a source fix or
 * `node scripts/api-contracts.mjs --bump aai-runtime:eval --drop "<reason>"`.
 *
 * ## What moved, and why epoch 4 survives it
 *
 * `StepUsage` became NAMEABLE. It is the parameter of `HostGenerateFn`'s
 * `onUsage`, added at this epoch — and at epoch 4 it was tagged `@internal` and
 * exported by no subpath, so a case could RECEIVE one and had no name to write
 * for it. `pnpm docs:md` and `pnpm check:api-nameable` both said so; epoch 5
 * retags it `@public` and `/eval` publishes it beside `HostGenerateFn`.
 *
 * An export ADDED is the safest transition this gate records, and what this
 * file freezes is the half that has to keep working: **an epoch-4 `generate`
 * double never spells `StepUsage`.** Both spellings it had are below — the
 * contextual one, where the parameter's type is inferred from `onUsage`, and
 * the structural one, where an author declared the record's shape themselves
 * because they could not import it. Neither may be broken by the type having
 * acquired a name.
 *
 * The direction that WOULD redden this file is `StepUsage` becoming something
 * an equivalent object literal no longer satisfies — a required field, a brand,
 * a field whose type narrowed — because the sink below is written against the
 * shape rather than against the name. Adding another optional counter is safe.
 *
 * ## Its shape, and why there is no roll-call
 *
 * Coverage is measured per CAPABILITY over the union of a capability's frozen
 * examples (`api-contracts-gate.test.ts`, "frozen examples import what its
 * epochs promised"), and `v1.ts`/`v2.ts` already carry the sixty-nine names
 * epoch 4 promised, with `v3.ts` carrying the five the text half added. Epoch 4
 * introduced no name of its own — `onUsage` is a field, not an export — so
 * everything it promised is already frozen, and this file is free to be about
 * the one thing that actually changed. A fourth near-copy of a seventy-name
 * roll-call would say nothing the first three do not.
 *
 * **Its imports are RELATIVE.** The same gate insists, and rightly: importing
 * `@alexkroman1/aai-runtime/eval` would resolve through the package's own
 * `exports` map to whatever the current build publishes, so the fixture would
 * prove the CURRENT surface compiles rather than that epoch 4's does.
 *
 * @module
 */

import { agent, tool } from "@alexkroman1/aai";
import { toolRegistry, withTools } from "@alexkroman1/aai/manifest";
import { expect } from "vitest";
import { z } from "zod";
import {
  type EvalSession,
  type EvalSessionOptions,
  errorsIn,
  type HostGenerateFn,
  openEvalSession,
  saidIn,
} from "../../../eval-barrel.ts";
import { type DescribeEvalOptions, describeEval } from "../../../eval-vitest-barrel.ts";

// ─── The agent under evaluation ──────────────────────────────────────────────
// EDIT POINT: in a real project this is `import agentDef from "./agent.ts"`.

const summarize = tool({
  description: "Summarize a note.",
  inputSchema: z.object({ note: z.string() }),
  // The tool that spends tokens: `ctx.generate` is what `onUsage` reports on,
  // so a case metering the agent is really metering calls made from in here.
  execute: async ({ note }, ctx) => (await ctx.generate({ prompt: `Summarize: ${note}` })).text,
});

const agentDef = withTools(
  agent({ name: "Desk", greeting: "Desk here." }),
  toolRegistry({ "tools/summarize.ts": { default: summarize } }),
);

// ─── EDIT POINT: what an epoch-4 case could write about a usage record ───────
//
// The shape, declared here because at this epoch there was no name to import.
// Every field is optional and every one may be `undefined`: a gateway that
// omits `inputTokens` on a cached turn is ordinary, and that is exactly what a
// running total has to survive.
type MeteredUsage = {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
};

/** What this suite adds up. One entry per completed generate step. */
const spent: number[] = [];

/**
 * The STRUCTURAL sink: a function of the author's own type, handed to
 * `onUsage`. It compiles because the record the runtime passes satisfies this
 * shape — not because the two share a name, which at epoch 4 they could not.
 */
const record = (usage: MeteredUsage): void => {
  spent.push(usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
};

/**
 * ── EDIT POINT: the `generate` a case supplies. ─────────────────────────
 *
 * A double rather than a live model, so a case asserting about tool behaviour
 * does not spend tokens on the summary it never reads. It is written against
 * the two call-options it USES and names neither of their types.
 */
const stubGenerate: HostGenerateFn = async (options, callOptions) => {
  if (callOptions?.signal?.aborted === true) throw new Error("generate: aborted");
  // Reported as an object LITERAL — the producer side of the same gap: an
  // epoch-4 double announced usage without being able to annotate it.
  callOptions?.onUsage?.({ inputTokens: options.prompt.length, outputTokens: 4, totalTokens: 12 });
  return { text: `summary of ${options.prompt.length} characters` };
};

/**
 * The CONTEXTUAL sink, wrapped around another double: `usage` here has a type
 * the author never wrote down, inferred from `onUsage` itself. This is the
 * spelling most cases reached for, and the one most easily broken by a change
 * to what `onUsage` takes.
 */
const metered =
  (inner: HostGenerateFn): HostGenerateFn =>
  async (options, callOptions) =>
    await inner(options, {
      ...callOptions,
      onUsage: (usage) => {
        record(usage);
        callOptions?.onUsage?.(usage);
      },
    });

// ─── EDIT POINT: what every case in this suite is opened with ───────────────
//
// `DescribeEvalOptions` is `EvalSessionOptions` minus the agent, because the
// suite already named it. The metered double belongs HERE rather than in a
// case: the meter is about the suite's whole spend.
const SUITE: DescribeEvalOptions = {
  env: {},
  generate: metered(stubGenerate),
};

describeEval(
  agentDef,
  (test) => {
    test(
      "the agent's generate spend is visible to the suite that drove it",
      async ({ session }) => {
        const turn = await session.say("Summarize my note about the delayed order.");

        expect(turn.completed).toBe(true);
        expect(saidIn(session.events()).length).toBeGreaterThan(0);
        expect(errorsIn(session.events())).toEqual([]);
        // The claim this file exists for: the meter saw the turn, through a
        // sink whose parameter type has no name on this epoch's surface.
        expect(spent.every((tokens) => tokens >= 0)).toBe(true);
      },
      { stubReply: [{ tool: "summarize", args: { note: "the delayed order" } }, "Here it is."] },
    );
  },
  SUITE,
);

/**
 * ── EDIT POINT: the same wiring without a runner. ───────────────────────
 *
 * `openEvalSession` is the door underneath `describeEval`, for a harness that
 * is not a vitest suite — a script that grades a hundred transcripts, say. The
 * options are the same bag with the agent put back, which is the whole reason
 * the suite form takes an `Omit` of it.
 */
const DIRECT: EvalSessionOptions = { ...SUITE, agent: agentDef };

/** Opened per run, closed by it — a session outliving its caller leaks a socket. */
export async function openMetered(): Promise<EvalSession> {
  return await openEvalSession(DIRECT);
}
