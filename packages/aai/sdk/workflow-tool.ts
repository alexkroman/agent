// Copyright 2026 the AAI authors. MIT license.
/**
 * `startTool()` — the tool that starts a workflow, in one line.
 *
 * Every voice agent that owns a workflow writes the same tool: take the
 * workflow's own input, start a run, answer the turn. Hand-written it is three
 * readable lines, and a wrapper around three readable lines is usually not worth
 * having — this repo deleted a whole pattern-combinator layer
 * (`@alexkroman1/aai/patterns`) for exactly that reason.
 *
 * What makes this one different is the CORRELATION KEY. `workflow_status` can
 * only report a run that was started with one, and nothing anywhere fails when
 * an author omits it: the run works, the tool answers, and the follow-up
 * question "is it ready yet?" is silently unanswerable for the rest of the call.
 * That is the failure a default closes, and it cannot be defaulted inside
 * `start` — a page's run legitimately has no session to key on. So it is
 * defaulted HERE, at the one call site that always does.
 *
 * The second thing it removes is a duplicated schema: the tool's `input`
 * IS the workflow's `input`, so an author who writes the tool by hand either
 * restates the schema or widens it and loses the validation `start` would have
 * done anyway.
 */

import { tool } from "./define.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import type { WorkflowDef } from "./workflow.ts";

/** Options every {@link startTool} form takes. */
export type StartToolOptions = {
  /** What the LLM reads to decide whether to call this. Required, as on any tool. */
  description: string;
  /**
   * What the tool answers once the run is journaled. Defaults to
   * `{ runId, status: "started" }`.
   *
   * The default deliberately does NOT phrase a sentence: the model composes the
   * reply, and a canned "I'll get right on that" competes with the system
   * prompt's voice rather than informing it.
   */
  reply?: (runId: string) => unknown;
  /**
   * Correlation key for the run, so a later turn — or a later call — can find
   * it. Defaults to `ctx.sessionId`, which is what makes the `workflow_status`
   * builtin able to report it.
   *
   * Override when the run belongs to something longer-lived than the session: a
   * phone number, an account id, an order.
   */
  key?: (ctx: ToolContext) => string;
};

/**
 * The half that lets a run input be DERIVED rather than dictated by the model.
 *
 * The plain form below equates the tool's schema with the workflow's, which is
 * right whenever the run's input is what the caller is asking for — a topic, a
 * file, a phone number. It is wrong whenever the input has to be assembled from
 * the SESSION: a workflow cannot read `ctx.state` (it outlives the session that
 * started it), so a run's input is the one handoff from session-scoped state to
 * durable work, and that snapshot is built by code, not by an LLM. Equating the
 * two schemas there means asking the model to retype a structure it is holding
 * only as a reference — `dispatch-center`'s after-action report wants an
 * `incidentId` and a forty-entry timeline, and only the first is a question.
 *
 * So `inputSchema` narrows what the model is asked for and `input` builds the
 * run's own input from it. They are required TOGETHER, which the overloads
 * enforce: a narrower tool schema with no mapper would hand `start()` arguments
 * its workflow never declared, and `start()` would reject them at run time —
 * the one mistake this whole helper exists to make unreachable.
 */
// An `interface … extends` rather than `StartToolOptions & { … }`: inference
// through an INTERSECTION does not fix `T` before the checker contextually types
// `input`, so every mapper parameter came out implicitly `any` (TS7031) and the
// helper's whole typing benefit was lost at exactly the call sites that need it.
// Extending flattens the members into one object type, and inference works.
export interface DerivedStartToolOptions<T extends ToolInputSchema, P extends ToolInputSchema>
  extends StartToolOptions {
  /** What the LLM is asked for — narrower than the workflow's own input. */
  inputSchema: T;
  /** Build the run's input from the tool's arguments and the live session. */
  input: (
    args: InferSchemaOutput<T>,
    ctx: ToolContext,
  ) => InferSchemaOutput<P> | Promise<InferSchemaOutput<P>>;
}

/**
 * The one place the tool's arguments become the run's input unconverted.
 *
 * Written as a helper taking `unknown` rather than a cast at the call site so the
 * conversion is legal without a double cast through `unknown` — the pattern this
 * repo counts and ratchets down. It is a typed SEAM: the invariant
 * ("no mapper means `T` is `P`") is stated once, here, with the construction-time
 * guard in `startTool` as its enforcement.
 */
function asRunInput<I>(args: unknown): I {
  return args as I;
}

/**
 * Build the tool that starts `workflow`.
 *
 * The tool's `input` schema is the workflow's own, so the LLM is shown exactly
 * the arguments the run validates against, and the run is keyed to the session
 * by default.
 *
 * @example
 * ```ts
 * import { agent, startTool, workflow } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const digest = workflow({
 *   input: z.object({ topic: z.string() }),
 *   run: ({ topic }) => ({ topic }),
 * });
 *
 * export default agent({
 *   name: "Researcher",
 *   workflows: { digest },
 *   builtinTools: ["workflow_status"],
 *   tools: {
 *     research: startTool(digest, { description: "Start overnight research on a topic" }),
 *   },
 * });
 * ```
 *
 * Pass `inputSchema` + `input` together to ask the model for something narrower
 * and build the run's input from it — see {@link DerivedStartToolOptions}.
 *
 * **One signature rather than two overloads, and the reason is inference.** The
 * natural spelling is an overload per form, with the derived one requiring the two
 * fields together so the type system enforces the pairing. It does not work:
 * under overload resolution the checker never fixes `T` before it contextually
 * types `input`, so every mapper parameter comes out implicitly `any`
 * (`TS7031`/`TS7006`) — silently discarding type safety inside the one function
 * that most needs it, in exchange for catching a mistake that is a one-line throw
 * away. So `T` defaults to `P` on a single signature (which is what makes the
 * plain form still return `ToolDef<P>`), and the pairing is checked at
 * construction. `workflow-tool.test-d.ts` pins the inference so the overload
 * version cannot be reintroduced without noticing.
 *
 * @public
 */
export function startTool<P extends ToolInputSchema, R, T extends ToolInputSchema = P>(
  workflow: WorkflowDef<P, R>,
  options: StartToolOptions & Partial<DerivedStartToolOptions<T, P>>,
): ToolDef<T> {
  const { description, reply = (runId: string) => ({ runId, status: "started" }) } = options;
  const keyOf = options.key ?? ((ctx: ToolContext) => ctx.sessionId);
  const derived = options.input;
  // Given a narrow schema and no mapper, the tool would hand `start()` arguments
  // its workflow never declared and the run would be rejected on its `input`
  // schema — at the far end of a tool call, reported to the model as a failure
  // whose cause is here. Thrown at CONSTRUCTION (module load, so `aai dev` and
  // the build both surface it) because the type system cannot: see the note on
  // the signature above.
  if (options.inputSchema !== undefined && derived === undefined) {
    throw new Error(
      "startTool: `inputSchema` needs an `input` mapper to build the run's own input from it " +
        "(drop both to take the workflow's schema as the tool's).",
    );
  }
  // `input` is present only when a schema exists on one side or the other — it
  // is optional on both, so a schemaless workflow with no override yields a
  // schemaless tool rather than an empty object schema the LLM would read as
  // "takes no arguments".
  //
  // Note the OPTION is still `inputSchema` while the FIELD it becomes is `input`:
  // this helper's `input` option is the mapper, so the two cannot share a name.
  // `startTool` goes away when a workflow becomes a tool directly, which is what
  // resolves the collision rather than a rename here.
  const schema = options.inputSchema ?? workflow.input;
  return tool<T>({
    description,
    ...(schema === undefined ? {} : { input: schema as T }),
    run: async (args: InferSchemaOutput<T>, ctx: ToolContext) => {
      // With no mapper `T` defaults to `P`, so the tool's own arguments ARE the
      // run's input — an equality the checker cannot see from inside the body,
      // hence the seam. The other way to instantiate `T` apart from `P` without a
      // mapper is rejected above, at construction.
      const input = derived ? await derived(args, ctx) : asRunInput<InferSchemaOutput<P>>(args);
      const runId = await ctx.workflows.start(workflow, input, { key: keyOf(ctx) });
      return reply(runId);
    },
  });
}
