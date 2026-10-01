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
import type {
  PipelineAgentParams,
  S2sAgentParams,
  TextAgentParams,
  WorkflowAppAgentParams,
} from "./agent-params.ts";
import type { ToolContext, ToolDef } from "./types.ts";

/**
 * `toAgentConfig` over a RAW record — one seam for every "the type rejects this
 * shape, does the runtime accept/reject it too" case, rather than a laundering
 * cast per assertion.
 *
 * `AgentConfigSource` deliberately forbids the shapes those specs exercise (a
 * `system` alias, a string `llm`, `mode: "text"`, a `mode` on a hand-written
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

/** Every key ANY member of a union has — `keyof` of a union is only the shared ones. */
type KeysOf<T> = T extends unknown ? keyof T : never;

/**
 * Whether an object LITERAL of type `X` is accepted where `M` is expected:
 * assignable, and carrying no key outside `M` — the excess-property check tsc
 * applies to a literal argument. For a union `M` the excess check is against
 * every member's keys, as tsc's is.
 *
 * Why a type and not structural `toExtend`: `agent()`'s members are CUT from
 * `AgentDef`, so a field a mode lacks is ABSENT from its member rather than
 * typed unsatisfiable, and an absent field is one an object may structurally
 * carry. What refuses it is the excess-property check on the literal — which
 * this models — and, for a caller that check never sees, `_agent-modes.ts`.
 * Why not an expect-error directive on a real call: every one is an escape
 * hatch the ratchet counts, and it passes on ANY error.
 */
export type Accepts<M, X> = [X] extends [M]
  ? [Exclude<keyof X, KeysOf<M>>] extends [never]
    ? true
    : false
  : false;

/**
 * Whether ANY overload of `agent()` accepts the literal `X` — i.e. whether the
 * call `agent(x)` compiles. One member per overload, plus the union one.
 */
export type AgentAccepts<X> = true extends
  | Accepts<PipelineAgentParams, X>
  | Accepts<S2sAgentParams, X>
  | Accepts<TextAgentParams, X>
  | Accepts<WorkflowAppAgentParams, X>
  ? true
  : false;
