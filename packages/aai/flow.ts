// Copyright 2025 the AAI authors. MIT license.
/**
 * Dialog management primitives for multi-step conversation flows.
 *
 * `defineFlow` creates a declarative state machine that integrates with
 * `defineAgent` via middleware. It handles step-specific instruction
 * injection, tool gating, and state transitions.
 *
 * @example
 * ```ts
 * import { defineFlow } from "@alexkroman1/aai/flow";
 * import { defineAgent, defineTool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const flow = defineFlow({
 *   initial: "greeting",
 *   steps: {
 *     greeting: {
 *       instructions: "Greet the user and ask what they need.",
 *       activeTools: ["lookup_services"],
 *       on: { SERVICE_SELECTED: "collect_info" },
 *     },
 *     collect_info: {
 *       instructions: "Collect name and preferred date.",
 *       activeTools: ["save_info"],
 *       on: { INFO_COMPLETE: "done" },
 *     },
 *     done: {
 *       instructions: "Confirm the booking. Thank the user.",
 *       terminal: true,
 *     },
 *   },
 * });
 *
 * export default defineAgent({
 *   name: "Booking Agent",
 *   instructions: "You are a booking assistant.",
 *   state: () => ({ ...flow.initialState(), name: "" }),
 *   middleware: [flow.middleware()],
 *   tools: {
 *     save_info: defineTool({
 *       description: "Save collected info and advance",
 *       parameters: z.object({ name: z.string() }),
 *       execute: (args, ctx) => {
 *         ctx.state.name = args.name;
 *         flow.transition(ctx, "INFO_COMPLETE");
 *         return "Saved.";
 *       },
 *     }),
 *   },
 * });
 * ```
 *
 * @module
 */

import type { Middleware } from "./types.ts";

/**
 * Configuration for a single step in a dialog flow.
 * @public
 */
export type FlowStep = {
  /**
   * Step-specific instructions prepended to the user's input so the LLM
   * knows what to do in this phase of the conversation.
   */
  instructions?: string;

  /**
   * Tools available during this step. When set, calls to tools not in this
   * list are blocked by the flow middleware. When omitted, all tools are
   * available.
   */
  activeTools?: readonly string[];

  /**
   * Transition map: event name → target step name.
   *
   * Tools trigger transitions by calling `flow.transition(ctx, "EVENT")`.
   */
  on?: Record<string, string>;

  /**
   * When `true`, no transitions are allowed from this step. The flow has
   * reached its final state.
   */
  terminal?: boolean;
};

/**
 * Configuration object passed to {@link defineFlow}.
 *
 * @typeParam Steps - Union of step name string literals, inferred from the
 *   `steps` object keys.
 *
 * @public
 */
export type FlowConfig<Steps extends string = string> = {
  /** The step the flow starts in when a new session begins. */
  initial: NoInfer<Steps>;
  /** Step definitions keyed by step name. */
  steps: Record<Steps, FlowStep>;
};

/**
 * Internal flow state stored in the session's `state` object.
 *
 * Merge this into your agent state via `flow.initialState()`.
 *
 * @public
 */
export type FlowState = {
  /** Current step name. */
  __flow: string;
};

/** Minimal context shape that `transition` and `currentStep` accept. */
type HasFlowState = { state: FlowState & Record<string, unknown> };

/**
 * A configured dialog flow returned by {@link defineFlow}.
 *
 * @typeParam Steps - Union of step name string literals.
 *
 * @public
 */
export type Flow<Steps extends string = string> = {
  /**
   * Returns the initial flow state to spread into your agent's `state` factory.
   *
   * @example
   * ```ts
   * state: () => ({ ...flow.initialState(), myField: "" })
   * ```
   */
  initialState(): FlowState;

  /**
   * Transition the flow to a new step by firing an event.
   *
   * Call this from within a tool's `execute` function to advance the dialog.
   * Throws if the event is not defined for the current step.
   *
   * @param ctx - The tool context (or any object with `{ state: FlowState }`)
   * @param event - The event name matching a key in the current step's `on` map
   */
  transition(ctx: HasFlowState, event: string): void;

  /**
   * Returns the current step name.
   */
  currentStep(ctx: HasFlowState): Steps;

  /**
   * Returns a middleware instance that handles instruction injection and
   * tool gating based on the current flow step.
   *
   * Add this to your agent's `middleware` array.
   */
  middleware(): Middleware;
};

/**
 * Define a dialog flow state machine for managing multi-step conversations.
 *
 * The returned {@link Flow} object provides:
 * - `initialState()` — merge into your agent's `state` factory
 * - `middleware()` — add to your agent's `middleware` array
 * - `transition(ctx, event)` — call from tools to advance the flow
 * - `currentStep(ctx)` — read the current step name
 *
 * @typeParam Steps - Inferred union of step name string literals.
 *
 * @public
 */
export function defineFlow<Steps extends string>(config: FlowConfig<Steps>): Flow<Steps> {
  const { initial, steps } = config;

  // Validate that all transition targets reference existing steps.
  for (const [name, step] of Object.entries<FlowStep>(steps)) {
    if (step.on) {
      for (const [event, target] of Object.entries(step.on)) {
        if (!(target in steps)) {
          throw new Error(
            `Flow step "${name}" has transition "${event}" targeting unknown step "${target}"`,
          );
        }
      }
    }
  }

  if (!(initial in steps)) {
    throw new Error(`Initial step "${initial}" is not defined in steps`);
  }

  return {
    initialState(): FlowState {
      return { __flow: initial };
    },

    transition(ctx: HasFlowState, event: string): void {
      const current = ctx.state.__flow;
      const step = steps[current as Steps];
      if (!step) {
        throw new Error(`Unknown flow step: "${current}"`);
      }
      if (step.terminal) {
        throw new Error(`Cannot transition from terminal step "${current}"`);
      }
      const target = step.on?.[event];
      if (!target) {
        throw new Error(
          `No transition "${event}" from step "${current}". ` +
            `Available events: ${step.on ? Object.keys(step.on).join(", ") : "none"}`,
        );
      }
      ctx.state.__flow = target;
    },

    currentStep(ctx: HasFlowState): Steps {
      return ctx.state.__flow as Steps;
    },

    middleware(): Middleware {
      return {
        name: "flow",

        beforeInput(text: string, ctx: HasFlowState): string {
          const current = ctx.state.__flow;
          const step = steps[current as Steps];
          if (!step?.instructions) return text;
          return `[Dialog step: ${current}]\n[Step instructions: ${step.instructions}]\n\n${text}`;
        },

        beforeToolCall(
          toolName: string,
          _args: Readonly<Record<string, unknown>>,
          ctx: HasFlowState,
        ) {
          const current = ctx.state.__flow;
          const step = steps[current as Steps];
          // If no activeTools defined for this step, allow everything.
          if (!step?.activeTools || step.activeTools.length === 0) {
            return;
          }
          if (!step.activeTools.includes(toolName)) {
            return {
              block: true,
              reason: `Tool "${toolName}" is not available in dialog step "${current}". Available tools: ${step.activeTools.join(", ")}`,
            };
          }
        },
      };
    },
  };
}
