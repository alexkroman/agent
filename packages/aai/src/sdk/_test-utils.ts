// Copyright 2026 the AAI authors. MIT license.
/**
 * The `sdk/` suites' own test helpers.
 *
 * Each package's helper module is its own and they are not interchangeable —
 * see the `test-helper-modules` konsistent convention. This is the SDK's
 * authoring-side one, sibling to `host/_test-utils.ts`: nothing here touches a
 * `node:` builtin, which is what lets `sdk/tsconfig.json` keep compiling this
 * tree with `types: []`.
 *
 * What lands here is a seam FOUR-plus specs had each written out, not every
 * fixture two files happen to share. A helper whose duplication is the point of
 * a test stays duplicated where it is — `dialog-plain-spec.test.ts`'s
 * `claimMachine` is the worked case, and its header says so.
 */

import { type AgentConfig, toAgentConfig } from "./agent-config.ts";
import type { ToolContext, ToolDef } from "./types.ts";

/**
 * `toAgentConfig` over a RAW record — one seam for every "the type rejects this
 * shape, does the runtime accept/reject it too" case, rather than a laundering
 * cast per assertion.
 *
 * `AgentConfigSource` deliberately forbids the shapes those specs exercise (a
 * `system` alias, a string `llm`, `text: true`, a `mode` on a hand-written
 * `export default {...}`, a guardrail on an s2s agent), because a TYPED caller
 * must not write them — but `toAgentConfig` is documented to accept them from a
 * raw object, and that behaviour is what the cases cover. Narrowing once means
 * adding a case costs no new suppression.
 *
 * It was declared FOUR times, in `config-rules.test.ts`, `_internal-types.test.ts`,
 * `agent-model-tuning.test.ts` and `config-rules-scope.test.ts`, two of them
 * spelling the cast differently — which is how a shared seam stops being one.
 */
export function rawConfig(fields: Record<string, unknown>): AgentConfig {
  return toAgentConfig(fields as Parameters<typeof toAgentConfig>[0]);
}

/**
 * Run a tool the way the runtime does, and hand back whatever it answered.
 *
 * The runtime calls `execute(args, ctx)` and keeps the resolved value whatever
 * its shape; a spec that reached for `tool.execute` directly would be pinning
 * the call convention rather than the tool. Args are `{}` because every caller
 * so far drives a no-argument dialog or slot tool.
 */
export async function runToolDef(tool: ToolDef, ctx: ToolContext): Promise<unknown> {
  return await tool.execute({}, ctx);
}
