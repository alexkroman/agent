// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:subagent` epoch 13.
 *
 * The delegation half of a research desk: two `subagent()` declarations — one
 * that searches the web on a cheap model with a narrow tool set, one that turns
 * what it found into something a voice agent can say — and the tool that runs
 * them with `ctx.delegate`. The point of the primitive is the CONTEXT WINDOW:
 * the parent never sees the lookups, only the paragraph they were worth.
 * Written the way it was authored at epoch 13, and it must keep compiling for
 * as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 13 survives it
 *
 * Nothing this capability exports. `aai:subagent`'s list is byte-identical
 * across the bump — `subagent`, `SubagentDef`, `SubagentToolCall`,
 * `DelegateFn`, `DelegateOptions`, `DelegateResult` — and the report hash moved
 * because `WorkflowBody`'s second parameter type was renamed
 * `WorkflowCtx` -> `WorkflowContext`.
 *
 * The route in is {@link SubagentDef}'s own `tools` map: its entries are
 * `ToolDef`s, whose `execute` takes a `ToolContext`, which has a `workflows`
 * member whose client mentions a `WorkflowDef`, whose body is a
 * `WorkflowBody`. So the renamed type is in this capability's rollup through
 * the very field {@link factCheck} below fills in — and it is still four hops
 * from anything written here.
 *
 * **This example never touches a workflow, and for a reason that is about the
 * primitive rather than about the file.** Delegation is BOUNDED and in-turn: the
 * caller is on the line, `delegate` resolves before `execute` returns, and the
 * whole budget is `maxSteps`. Work that has to outlive the turn is what a
 * durable run is for, and a subagent that started one would be answering a
 * question nobody asked it. So no name in this file has anything to do with
 * `WorkflowBody`, and a rename of its parameter type cannot reach it.
 *
 * **The direction that WOULD break this file is a SIGNATURE**, and this
 * capability has two that carry real weight. {@link DelegateResult} losing
 * `steps` or `toolCalls` — the half a voice agent needs in order to say
 * something true about the wait, which {@link narrate} is entirely built on —
 * or {@link DelegateOptions.context} becoming required, which would make every
 * call site claim the subagent needs the conversation to make sense. Both
 * redden here.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 13 has to be dropped with a reason.
 */

import { z } from "zod";
import { fetchJson } from "../../../host/agent-tools.ts";
import {
  type DelegateFn,
  type DelegateOptions,
  type DelegateResult,
  isToolFailure,
  type SubagentDef,
  type SubagentToolCall,
  subagent,
  tool,
  toolFailure,
} from "../../../index.ts";

/**
 * ── EDIT: a tool only the subagent may call. ─────────────────────────────
 *
 * A `tools/` file is what the CALLER can reach; a subagent's `tools` map is the
 * strictly narrower set one delegated task can reach, which is why this tool is
 * declared here rather than in `tools/` — nothing on the parent's turn should be
 * able to call it.
 */
const factCheck = tool({
  description: "Check one claim against the reference API. Answers with a verdict and a source.",
  inputSchema: z.object({ claim: z.string().max(300) }),
  execute: async ({ claim }, ctx) => {
    const answer = await fetchJson<{ verdict: string; source: string }>({
      url: `https://facts.example.com/v1/check?q=${encodeURIComponent(claim)}`,
      signal: ctx.signal,
    });
    // The builtins ANSWER a failure rather than throwing one, so an unnarrowed
    // read here would report a refused request as a verdict.
    if (isToolFailure(answer)) return answer;
    return { claim, verdict: answer.verdict, source: answer.source };
  },
});

/**
 * ── EDIT: the subagent that does the looking. ────────────────────────────
 *
 * **The systemPrompt tells it to summarize, and that is not decoration.** The
 * parent gets {@link DelegateResult.text}, which is this subagent's FINAL
 * message — so one that ends its run saying "Done." has thrown away everything
 * it learned, and no step budget recovers it.
 *
 * `llm` is a cheaper model than the desk's own, named as a string, which is the
 * usual reason to set the field at all: a subagent doing lookups spends most of
 * its tokens reading tool results rather than reasoning about them.
 *
 * `maxSteps` is the mechanism the whole primitive rests on. A subagent told to
 * keep looking until it is sure is a subagent whose cost nobody can quote; past
 * the cap it is asked for its answer with tools withheld, so a capped run still
 * comes back as prose.
 */
export const researcher = subagent({
  name: "researcher",
  systemPrompt:
    "Research the task with the tools you have. Check anything that sounds like a " +
    "number or a date with check_fact. When you are done, write one paragraph of " +
    "what you found and where it came from — that paragraph is all the caller sees.",
  llm: "qwen3-next-80b-a3b",
  builtinTools: ["web_search", "visit_webpage"],
  tools: { check_fact: factCheck },
  maxSteps: 6,
  temperature: 0.2,
});

/**
 * The second subagent, and the reason there are two.
 *
 * A pure reasoning pass — no tools of any kind, which is legal and is
 * occasionally exactly what is wanted. It is handed the researcher's paragraph
 * and asked for something that can be SAID, which is a different job from
 * finding it and gets a different prompt and a tighter output cap.
 */
export const phrasing = subagent({
  name: "phrasing",
  systemPrompt:
    "Rewrite what you are given as two sentences a person could say out loud on a " +
    "phone call. No lists, no numbers read as digits, no citations.",
  maxSteps: 1,
  maxOutputTokens: 200,
});

/**
 * ── EDIT: the desk's subagents, by name. ─────────────────────────────────
 *
 * Typed as the contract's own {@link SubagentDef} so a declaration that stopped
 * being one is an error here, and named so the tool below can be told which to
 * run rather than closing over one.
 */
export const desk: Readonly<Record<string, SubagentDef>> = { researcher, phrasing };

/**
 * What a run COST, in words the agent can say while the caller waits.
 *
 * `steps` and `toolCalls` are a REPORT rather than a transcript — the tool
 * RESULTS stayed inside the subagent's context, which is the entire reason to
 * have delegated — and that is what makes this the honest thing to read out:
 * "I checked four sources" is derivable, and what any of them said is not.
 */
export function narrate(result: DelegateResult): string {
  const sources = result.toolCalls.filter((call: SubagentToolCall) => call.name !== "check_fact");
  const suffix = sources.length === 1 ? "source" : "sources";
  return `${result.text} (${sources.length} ${suffix}, ${result.steps} steps)`;
}

/**
 * ── EDIT: the module that is handed the CAPABILITY rather than the context. ──
 *
 * `DelegateFn` is `ctx.delegate`'s own type, so a helper can take the capability
 * alone. That is what keeps the two-stage pass below out of the tool body and
 * testable on its own — a spec hands it a fake `delegate` and nothing else.
 *
 * The second call's `context` is the first call's answer. A subagent's context is
 * ISOLATED, so it has read no conversation and knows nothing the task and this
 * field do not say; a task that needed the call transcript to make sense is one
 * that was underspecified.
 */
export async function research(
  delegate: DelegateFn,
  question: string,
): Promise<{ said: string; steps: number }> {
  const found = await delegate(researcher, {
    task: `Find out: ${question}. Say what you found and where.`,
  });
  const options: DelegateOptions = {
    task: "Say this on a phone call.",
    context: found.text,
    // Overridden per call: phrasing never needs more than one step, and a
    // budget stated at the call site is the one a reader of this line can see.
    maxSteps: 1,
  };
  const spoken = await delegate(phrasing, options);
  return { said: spoken.text, steps: found.steps + spoken.steps };
}

/**
 * The tool the model actually calls.
 *
 * `delegate` REJECTS when a run cannot be started — no LLM named, an unknown
 * builtin — and when the parent's turn is cancelled. A subagent whose own tool
 * fails does not reject: that failure goes back to the subagent as a tool
 * result, exactly as it would in the parent loop, and the subagent gets to
 * recover from it.
 */
export const lookUp = tool({
  description: "Research a question that needs more than one lookup, and say what was found.",
  inputSchema: z.object({
    question: z.string().max(300).describe("The question, as the caller asked it"),
  }),
  execute: async ({ question }, ctx) => {
    try {
      const { said, steps } = await research(ctx.delegate, question);
      return { answer: said, steps };
    } catch {
      // A rejection is the agent breaking rather than the research failing, so
      // it is reported to the model as something to say rather than rethrown
      // into the caller's ear.
      return toolFailure("I could not get that looked up just now. Ask me again in a moment.");
    }
  },
});
