// Copyright 2026 the AAI authors. MIT license.
/**
 * `agent({ subagents })` — a ROSTER of subagents the model chooses between,
 * published as one tool.
 *
 * `ctx.delegate(factChecker, …)` decides in CODE which subagent runs. That is
 * the right shape when a tool IS the choice — `verify_claim` delegates to the
 * fact-checker and to nothing else, and the decision is as testable as any other
 * branch. It stops being the right shape the moment the choice is the model's:
 * a front desk with eight subagents needs eight tool files whose bodies differ
 * only in which subagent they name, or one tool with an eight-way `if` over an
 * argument the model supplies — which is this module, hand-written once per
 * agent, without the roster in the tool's description and therefore with nothing
 * telling the model what the eight subagents are FOR.
 *
 * So a roster is declared and the tool is generated:
 *
 * ```ts
 * import { agent, subagent } from "@alexkroman1/aai";
 *
 * const billing = subagent({
 *   name: "billing",
 *   description: "Answers billing, invoice and refund questions",
 *   systemPrompt: "You are the billing desk.",
 *   expectedOutput: "A direct answer in two sentences.",
 * });
 *
 * const tech = subagent({
 *   name: "tech",
 *   description: "Diagnoses connection and hardware faults",
 *   systemPrompt: "You are technical support.",
 *   expectedOutput: "The likeliest cause, and one thing to try.",
 * });
 *
 * export default agent({ name: "Front Desk", subagents: [billing, tech] });
 * ```
 *
 * and the model gets one `delegate` tool whose `subagent` argument is an enum
 * over those names, described by each one's {@link SubagentDef.description}.
 * Adding a third subagent is one line and no new file.
 *
 * ## One word for it, and the MODEL reads the same one
 *
 * The enum key is `subagent` because the field is `subagents`, the type is
 * {@link SubagentDef} and the helper is {@link subagent} — one word from the
 * declaration through to the argument the router fills in. It was `coworker`,
 * inherited from CrewAI along with `expectedOutput` and the guardrail retry
 * budget, and it was the one name of the four that nobody could grep for: an
 * author reading `agent({ subagents })` and a model reading `coworker` were
 * given no reason to believe they were the same thing, and this module's own
 * prose called them "specialists" while doing it. Renaming the KEY changes the
 * tool's JSON schema and nothing an author compiles against, which is why this
 * half was the cheap one — but it is also the half that decides routing
 * accuracy, since it is the only one of the four the model ever sees.
 *
 * The tool itself stays `delegate` ({@link DELEGATE_TOOL_NAME}): it names the
 * ACT rather than the thing acted on, `ctx.delegate` is the call-site half of
 * the same capability, and both are published.
 *
 * ## The name is the DEF's, and there is only one of them
 *
 * A roster is an ARRAY rather than a `{ key: def }` map, unlike
 * `agent({ workflows })`. A workflow definition carries no name of its own, so
 * its key IS its name; a {@link SubagentDef} already has `name`, and a map would
 * mint a second one — `{ factChecker: { name: "fact-checker" } }` gives the
 * model one string, the log line another, and nothing reconciles them.
 *
 * ## What this module does NOT do
 *
 * It does not make delegation recursive, and it does not let a subagent choose a
 * subagent of its own. The generated tool runs in the PARENT's tool loop, so the one-level
 * rule (`NESTED_DELEGATE_MESSAGE`) is untouched: a roster subagent's own tools
 * still cannot delegate. A manager that routes to a manager is the shape whose
 * bill nobody can quote, which is the same argument, and being a roster does not
 * change it.
 */

import { z } from "zod";
import { omitUndefined } from "./omit-undefined.ts";
import type { SubagentDef } from "./subagent.ts";
import type { ToolDef } from "./types.ts";
import { toolFailure } from "./utils.ts";

/**
 * The subagents an agent publishes for the MODEL to choose between —
 * `agent({ subagents })`.
 *
 * Every entry needs a {@link SubagentDef.description}: it is the only thing the
 * router reads, and `agent()` refuses a roster without one rather than shipping
 * an agent that picks off a list of bare names.
 *
 * @public
 */
export type SubagentRoster = readonly SubagentDef[];

/**
 * The name the model calls a roster by.
 *
 * One tool with a `subagent` argument rather than one tool PER subagent, which
 * is the other obvious lowering. Per-subagent tools put the roster in the tool
 * LIST, which reads well — and the list is fixed for the whole session
 * (`toolSchemas` is computed once and handed to the transport at session
 * creation, the same constraint `sdk/dialog.ts` documents), so a roster that
 * varies by state is unreachable either way, and n tools cost n schemas in every
 * request where this costs one. The deciding reason is smaller: `delegate` is
 * also where a shared instruction about HOW to brief a subagent goes, and n
 * copies of it is n places for it to drift.
 *
 * @public
 */
export const DELEGATE_TOOL_NAME = "delegate";

/**
 * Check a roster and build the tool that publishes it.
 *
 * Called by `agent()`, so every refusal here reaches an author at the
 * declaration rather than at the first turn that tries to route. That is the
 * whole reason the checks are not merely documented: a roster entry with no
 * description does not fail — it produces an agent that routes badly, which
 * nothing reports and which reads as the model being unreliable.
 *
 * @internal
 */
export function rosterTool(roster: SubagentRoster): ToolDef {
  assertRoster(roster);
  const byName = new Map(roster.map((one) => [one.name, one]));
  // zod wants a non-empty tuple; `assertRoster` has already established one.
  const names = roster.map((one) => one.name) as [string, ...string[]];

  const inputSchema = z.object({
    subagent: z.enum(names).describe("Which subagent should do this."),
    task: z
      .string()
      .describe(
        "The COMPLETE brief. The subagent has not heard this conversation and " +
          "knows nothing you do not tell it here.",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "Anything already established that the subagent should not go looking " +
          "for again, or already ruled out.",
      ),
  });

  // Annotated on the CONST rather than on this function's return type, so
  // `execute`'s parameters are contextually typed by the schema above. A bare
  // `ToolDef` return annotation types them `Record<string, unknown>` — the
  // default `ToolInputSchema`'s output — and the body loses the enum it exists
  // to switch on.
  const def: ToolDef<typeof inputSchema> = {
    description: describeRoster(roster),
    inputSchema,
    async execute({ subagent, task, context }, ctx) {
      // Named for the ROLE rather than the argument, which is `subagent` now:
      // one `const subagent =` here would shadow the name the enum arrived under
      // and read as a re-assignment rather than a lookup.
      const chosen = byName.get(subagent);
      // Unreachable through the enum, and checked anyway: a model can send an
      // argument no schema sanctioned (a repaired tool call, a provider that
      // ignores the enum), and the failure to avoid is `undefined` reaching
      // `ctx.delegate` and rejecting with something about a missing systemPrompt.
      if (!chosen) {
        return toolFailure(
          `There is no subagent called "${subagent}". Available: ${names.join(", ")}.`,
        );
      }
      const result = await ctx.delegate(chosen, {
        task,
        ...omitUndefined({ context }),
      });
      return {
        subagent,
        answer: result.text,
        /** What the wait bought, so the agent can say something true about it. */
        lookups: result.toolCalls.length,
        // Present only when the subagent's own guardrail never accepted the
        // answer — a field whose PRESENCE is the warning, rather than an
        // `accepted: true` the model reads past on every successful call.
        // Keyed off `complaint` rather than off `accepted`, which would be two
        // readings of one fact: the contract sets the complaint exactly when it
        // did not accept.
        ...omitUndefined({ unverified: result.complaint }),
      };
    },
  };
  return def;
}

/**
 * The tool description: what delegating is for, then who is available.
 *
 * The roster is rendered INTO the description as well as being the `subagent`
 * enum, because an enum gives the model a list of names and no way to tell them
 * apart. This is the whole content of the routing decision.
 */
function describeRoster(roster: SubagentRoster): string {
  return [
    "Hand a self-contained task to a subagent and get its answer back. Use " +
      "this when a request is squarely one subagent's job — not for something " +
      "you can answer yourself, and not to ask a subagent what it thinks of " +
      "another subagent's answer.",
    "",
    "Subagents:",
    ...roster.map((one) => `- ${one.name}: ${one.description}`),
  ].join("\n");
}

/**
 * Refuse a roster that cannot route.
 *
 * Each of the three is a failure with NO SYMPTOM: an agent that routes to the
 * wrong subagent, or to one of two identically-named ones, looks exactly like
 * an agent whose model is having a bad day.
 */
function assertRoster(roster: SubagentRoster): void {
  if (roster.length === 0) {
    throw new Error(
      "agent({ subagents: [] }) declares a roster with nobody on it — the `delegate` tool would " +
        "offer the model no one to choose. List the subagents, or drop the field.",
    );
  }
  const seen = new Set<string>();
  for (const one of roster) {
    if (!one.description) {
      throw new Error(
        `The subagent "${one.name}" is on this agent's roster and has no \`description\`. That is ` +
          "the only thing the model reads when it picks a subagent — its `systemPrompt` is " +
          "written for the subagent, not for whoever is choosing one. Add a line saying what this " +
          'one is FOR (e.g. "Answers billing and invoice questions").',
      );
    }
    if (seen.has(one.name)) {
      throw new Error(
        `Two subagents on this agent's roster are called "${one.name}". The name is what the model ` +
          "names a subagent by, so one of them has to be renamed.",
      );
    }
    seen.add(one.name);
  }
}
