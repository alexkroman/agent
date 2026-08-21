// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate every flow tool goes through, shared by both flow kinds.
 *
 * `flow()` stores a position and moves it with events; `derivedFlow()` computes
 * one from the data it is about. Everything BETWEEN those two — validating
 * `when` against the machine's own states, refusing out of state with a message
 * the model can recover from, refusing to advance past a `ToolFailure`, and
 * wrapping the body's value in the position it landed in — is identical, and was
 * identical by copy until this module existed.
 *
 * Extracting it is what keeps the two factories honest about their one real
 * difference. A derived flow passes no `advance`, because there is nothing to
 * advance: its position is a function of the slot the body just wrote.
 *
 * Internal (`_`-prefixed): `flow()` and `derivedFlow()` are the public surface.
 * The types are imported TYPE-ONLY from `./flow.ts`, so the public definitions
 * stay in the module the API report names and this adds no runtime edge back.
 */

import type { FlowPosition, FlowToolResult } from "./flow.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import { isToolFailure, type ToolFailure, toolFailure } from "./utils.ts";

/**
 * What a flow kind hands the gate: how to read a position, and how (or whether)
 * a successful body moves it.
 */
export interface FlowGate<R> {
  /** The flow's key, for error messages that name which flow refused. */
  readonly key: string;
  /** Every state path the machine can be in, for validating `when`. */
  readonly valid: ReadonlySet<string>;
  position(ctx: ToolContext): FlowPosition;
  matches(ctx: ToolContext, state: string): boolean;
  /**
   * The disagreement check, when the flow declares one. A returned string is a
   * description of how the position and the data have come apart.
   */
  check?(ctx: ToolContext): string | undefined;
  /**
   * Move the flow after a successful body, and answer where it landed. Omitted
   * by a DERIVED flow, whose position already followed the body's write — the
   * gate then just re-reads.
   */
  advance?(result: R, ctx: ToolContext): FlowPosition;
}

/** The half of a tool declaration the gate needs, minus how it advances. */
export interface GatedToolSpec<P extends ToolInputSchema, R> {
  description: string;
  inputSchema?: P;
  when: string | readonly string[];
  execute(args: InferSchemaOutput<P>, ctx: ToolContext): R | ToolFailure | Promise<R | ToolFailure>;
}

/**
 * Validate `when` against the machine, and throw naming the real states.
 *
 * At DECLARATION time, so a typo is a startup throw rather than a tool that is
 * silently unreachable for the life of the agent.
 */
export function validateWhen(
  key: string,
  valid: ReadonlySet<string>,
  when: string | readonly string[],
): readonly string[] {
  const allowed = typeof when === "string" ? [when] : when;
  for (const state of allowed) {
    if (valid.has(state)) continue;
    throw new Error(
      `Flow "${key}" has no state "${state}", so a tool gated on it could never run. Its states are: ${[...valid].sort().join(", ")}.`,
    );
  }
  return allowed;
}

/**
 * Build the `ToolDef` for a gated tool.
 *
 * The ORDER here is the whole contract, and each step is load-bearing:
 *
 * 1. **The invariant first.** A position that disagrees with its data makes
 *    every later step wrong, and the gate is the moment that matters — it is
 *    where a wrong position turns into a wrong decision. Reporting the
 *    disagreement beats refusing on it, because the refusal a stale position
 *    produces READS CORRECT: it names a real state and quotes that state's real
 *    instruction, so the model apologizes and retries something that cannot
 *    work. See `FlowOptions.invariant`.
 * 2. **The gate, before the body.** Out of state nothing runs, and the refusal
 *    names where the conversation actually is and what the flow expects there.
 * 3. **`await` the body**, so the failure check and the transition both read the
 *    settled value. A synchronous version tested `isToolFailure` on a pending
 *    promise (always false), so an async tool that failed advanced anyway.
 * 4. **A `ToolFailure` does not advance.** A tool that failed did not do the
 *    thing; a flow a step ahead of reality makes every later gate wrong too.
 */
export function buildFlowTool<P extends ToolInputSchema, R>(
  gate: FlowGate<R>,
  spec: GatedToolSpec<P, R>,
): ToolDef<P> {
  const allowed = validateWhen(gate.key, gate.valid, spec.when);
  const { execute, when: _when, ...rest } = spec;
  return {
    // Spread rather than restating `inputSchema`, for the reason
    // `SessionSlot.tool` gives: rebuilding it field by field cannot preserve its
    // optionality against a still-generic `P`.
    ...rest,
    execute: async (args, ctx): Promise<FlowToolResult<R> | ToolFailure> => {
      const disagreement = gate.check?.(ctx);
      if (disagreement !== undefined) {
        return toolFailure(
          `The "${gate.key}" flow and the data it tracks disagree: ${disagreement} ` +
            "This is a bug in the agent rather than something the caller did — do not retry, and say the request cannot be completed.",
        );
      }
      const at = gate.position(ctx);
      if (!allowed.some((state) => gate.matches(ctx, state))) {
        const expectation = at.instruction ?? `reach ${allowed.join(" or ")} first`;
        return toolFailure(
          `Not available yet: this conversation is at "${at.state}". ${expectation}`,
        );
      }
      const result = await execute(args, ctx);
      if (isToolFailure(result)) return result;
      // Re-READ rather than reusing `at`: the LLM loop runs a step's tool calls
      // concurrently, so a sibling may have moved the flow while this body was
      // awaiting, and reporting the position this call started at would describe
      // a conversation that has moved on. A derived flow has no `advance` and
      // this re-read IS its transition — the body wrote the data the position is
      // computed from.
      const moved = gate.advance?.(result, ctx) ?? gate.position(ctx);
      return { ...moved, result };
    },
  };
}
