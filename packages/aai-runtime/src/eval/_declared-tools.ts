// Copyright 2026 the AAI authors. MIT license.
/**
 * What the agent under eval DECLARES, checked against what a case scripts.
 *
 * A tool is a FILE, so `agent.ts`'s default export carries an empty tool table
 * and `virtual:aai/agent` is the lowered agent that carries the real one. Hand
 * `describeEval` the authored def and nothing refuses it: the suite boots, the
 * scripted model emits a `tool-call` for a tool the agent does not declare,
 * nothing answers it, and the case fails dozens of lines away on
 * `expected [] to contain 'look_up_order'` — the symptom, with the cause on the
 * `describeEval(...)` line nobody is looking at.
 *
 * `toolRunner` (`@alexkroman1/aai/testing`) already refuses the same mistake at
 * BIND for the same reason. This module is that guard for the other door, in
 * two halves that fail differently on purpose:
 *
 * - {@link checkStubReplyTools} THROWS, at case declaration. A `stubReply` step
 *   naming a tool the agent does not declare has no legitimate reading — the
 *   script decides what the model emits, and it emitted a call nothing can
 *   serve — so this is exact, and it fires only when a script names a tool.
 * - {@link announceToollessAgent} WARNS, once per suite. A tool-less
 *   conversational agent is a legal eval target, so this may never block; what
 *   it covers is everything the throw cannot — a suite with no scripted tool
 *   call at all, and a LIVE run, where there is no script to check.
 *
 * Its own module rather than part of `describe.ts` for the ordinary reason:
 * that file sits within a handful of lines of the 500-line cap, and the
 * argument above is longer than the code it guards. `hasWorkflows` came with
 * it, being the third question this module asks about a lowered def.
 *
 * @module
 */

import type { AgentDef } from "@alexkroman1/aai";
import { announceEvalMode } from "./_announce.ts";
import type { StubScript } from "./stub-llm.ts";

/**
 * Why an agent declares NO tools, and what to import instead.
 *
 * A COPY of `AUTHORED_DEF_HINT` in `packages/aai/src/sdk/testing-tools.ts`,
 * which is module-private there — reaching it would mean adding a name to a
 * published `@alexkroman1/aai` subpath, which owes an api-report regeneration
 * this change is not otherwise entitled to. `describe.test.ts` pins the two
 * against each other through `toolRunner`'s own throw, so the drift a second
 * copy invites is a test failure rather than two remedies that disagree.
 */
export const AUTHORED_DEF_HINT =
  "A tool is a FILE, so an agent.ts default export carries none of them — " +
  'import the agent as DEPLOYED instead: `import agentDef from "virtual:aai/agent"` ' +
  "under vitest, or `deployedAgent` from @alexkroman1/aai/testing under any other runner.";

/**
 * Does this agent declare a workflow for a tool to start?
 *
 * Here rather than in `describe.ts` because it is the same question the rest of
 * this module asks — what the lowering put on the def — and `runCase` imports
 * it back for the one decision it drives: whether to open a workflow engine.
 */
export function hasWorkflows(agent: AgentDef): boolean {
  return Object.keys(agent.workflows ?? {}).length > 0;
}

/** The tool names a scripted turn would have the model emit, in order. */
function toolsNamedBy(script: StubScript): string[] {
  if (typeof script === "string") return [];
  return script.flatMap((step) =>
    typeof step === "string" || !("tool" in step) ? [] : [step.tool],
  );
}

/**
 * Refuse a `stubReply` that calls a tool this agent does not declare.
 *
 * Thrown from inside `define(...)`, so it surfaces as a COLLECTION error on the
 * eval file — the case never registers, and the message sits on the line that
 * is wrong rather than in the failure of a case several dozen lines below.
 */
export function checkStubReplyTools(
  agent: AgentDef,
  caseName: string,
  script: StubScript | undefined,
): void {
  if (script === undefined) return;
  // An MCP server's tools are discovered from the LIVE server and attached by
  // `withMcpTools` at host start; a lowered `virtual:aai/agent` carries none of
  // them. So an agent that declares a server is one this check cannot reason
  // about, and staying quiet is the only honest answer.
  if (Object.keys(agent.mcpServers ?? {}).length > 0) return;
  // The model's tool table is `tools` PLUS `builtinTools` — the union
  // `mergeBuiltinSurface` serves. Reading only `tools` made every builtin a
  // false positive: three shipped templates script `run_code`/`visit_webpage`
  // against a `builtinTools` entry, and the guard called each one undeclared.
  const declared = [...Object.keys(agent.tools ?? {}), ...(agent.builtinTools ?? [])];
  const missing = toolsNamedBy(script).find((name) => !declared.includes(name));
  if (missing === undefined) return;
  throw new Error(
    `stubReply for the eval case "${caseName}" scripts a call to the tool \`${missing}\`, ` +
      `which ${agent.name} does not declare. It declares: ` +
      `${declared.length > 0 ? declared.join(", ") : "(none)"}. A scripted tool call the agent ` +
      "cannot serve measures nothing: the model emits it, no tool answers, and the case fails " +
      "further down on the symptom rather than on this line. " +
      // The empty table is the authored-def mistake and nothing else; a
      // non-empty one that misses a name is a rename or a typo, and the hint
      // would be a non-sequitur. `toolOf` splits its own message the same way.
      (declared.length > 0
        ? `Fix the name in stubReply, add tools/${missing}.ts, or name it in builtinTools.`
        : AUTHORED_DEF_HINT),
  );
}

/**
 * Say so — once, before any case — when the agent under eval declares nothing
 * for a tool call to reach.
 *
 * A WARNING rather than a throw, and it must stay one: an agent that only talks
 * is a legal eval target, and several shipped templates are exactly that. What
 * makes the line worth printing anyway is that the alternative reading — the
 * authored def, imported by mistake — looks identical from here and is by far
 * the more common one, in a suite that will otherwise report green while
 * measuring an agent with no capabilities at all.
 *
 * Gated on WORKFLOWS too: an agent that hands off to a run declares its tools
 * in the same lowering, so a workflow-carrying def has plainly been lowered and
 * the notice would be noise.
 */
export function announceToollessAgent(agent: AgentDef): void {
  if (Object.keys(agent.tools ?? {}).length > 0) return;
  if (hasWorkflows(agent)) return;
  announceEvalMode(
    `eval: ${agent.name} — this agent declares no tools and no workflows, so this suite can ` +
      `only measure what it says. If that is unexpected: ${AUTHORED_DEF_HINT}`,
  );
}
