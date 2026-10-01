// Copyright 2026 the AAI authors. MIT license.
/**
 * ONE tool call, as every transport runs it: the core both the pipeline's AI
 * SDK adapter (`to-vercel-tools.ts`) and the S2S tool step
 * (`../session/tool-steps.ts`) call.
 *
 * ## Why one function
 *
 * The pipeline runs a tool inside `streamText`; an S2S transport reports
 * `tool.called` and the session runs it. Those were two copies of the same
 * five steps, and they had drifted: the S2S copy never coerced stringified
 * scalars toward the schema (`"1500"` reached the tool as a string), and each
 * kept its own comment explaining why the history was snapshotted and where
 * the model's copy of the result came from. What differs between the two is
 * WHO the result goes to and what a rejection becomes — not how the call runs.
 *
 * So this module owns the call, in order:
 *
 * 1. **Coerce** the arguments toward the tool's declared parameters
 *    (`arg-coercion.ts`), before the tool — or a relay observer — sees them.
 * 2. **Snapshot** the conversation, so a transcript landing mid-call cannot
 *    leak into the tool's view.
 * 3. **`beforeExecute`**, the one hook — the pipeline's tool speech needs the
 *    COERCED input to open its START line, and a `blocking` start holds the
 *    call up.
 * 4. **Execute** through {@link ExecuteTool}, which owns validation, context,
 *    gates and the deadline.
 * 5. **Record** the tool's own result in the conversation (`recordToolResult`)
 *    in completion order, and hand back the MODEL's copy beside it — record
 *    collections as rows (`../_compact-records.ts`).
 *
 * ## A rejection is returned to the CALLER's policy, never decided here
 *
 * `executeTool` rejects on exactly one path — a `FatalToolError`, a failure
 * the author declared unrecoverable — plus the executor itself failing. This
 * core rethrows both untouched and records nothing, because what a rejection
 * becomes is a TRANSPORT fact, the `fatalTool` capability: the pipeline stops
 * the turn (`FatalToolLatch`), an S2S service cannot be stopped mid-reply and
 * answers the call with a serialized failure instead.
 */

import type { Message } from "@alexkroman1/aai";
import type { ExecuteTool, ExecuteToolOptions } from "@alexkroman1/aai/host-internal";
import type { JSONSchema7 } from "json-schema";
import { compactRecordsForModel } from "../_compact-records.ts";
import { coerceToolArgs } from "./arg-coercion.ts";
import { toolResultMessage } from "./result-message.ts";

/** One call, as the transport reported it. */
export type ToolCallRequest = {
  name: string;
  args: Readonly<Record<string, unknown>>;
  /** The provider's id for the call — absent only where the vendor omits one. */
  toolCallId?: string | undefined;
  signal?: AbortSignal | undefined;
};

/** What a call runs against: the session's side of it. */
export type ToolCallContext = {
  executeTool: ExecuteTool;
  sessionId: string;
  /** The live conversation, snapshotted per call. */
  messages: () => readonly Message[];
  /**
   * The tool's declared parameters, for argument coercion. Absent (or
   * answering `undefined`) leaves the arguments as the model sent them.
   */
  parameters?: ((name: string) => JSONSchema7 | undefined) | undefined;
  /**
   * Where the settled call's own result goes, so the NEXT tool call reads it
   * through `ctx.messages`. Optional: a `TextAgent.tools` set is bound to no
   * conversation.
   */
  recordToolResult?: ((message: Message) => void) | undefined;
};

/** A call that settled with a result the model reads. */
export type SettledToolCall = {
  /** The arguments the tool actually ran with — after coercion. */
  input: Readonly<Record<string, unknown>>;
  /** The tool's own string: what the client's `tool.completed` and the history carry. */
  result: string;
  /** What the MODEL is sent: `result` with record collections rendered as rows. */
  forModel: string;
};

/** The hook between coercion and execution — see the module doc, step 3. */
export type BeforeToolExecute = (input: Readonly<Record<string, unknown>>) => Promise<void>;

/**
 * Coerce a call's arguments toward the tool's declared parameters — step 1,
 * exported for a caller that needs the input before the call (the pipeline's
 * tool speech).
 */
export function coerceCallArgs(
  name: string,
  args: Readonly<Record<string, unknown>>,
  ctx: Pick<ToolCallContext, "parameters">,
): Readonly<Record<string, unknown>> {
  const parameters = ctx.parameters?.(name);
  return parameters === undefined ? args : coerceToolArgs(args, parameters);
}

/**
 * Run one tool call — see this module's doc. Rejects only where
 * {@link ExecuteTool} does, with nothing recorded.
 *
 * @internal
 */
export async function runToolCall(
  call: ToolCallRequest,
  ctx: ToolCallContext,
  beforeExecute?: BeforeToolExecute,
): Promise<SettledToolCall> {
  const input = coerceCallArgs(call.name, call.args, ctx);
  const history = ctx.messages().slice();
  // Awaited only when there IS a hook: an `await` on nothing would still yield
  // a microtask, and the S2S step relies on `executeTool` STARTING
  // synchronously with the report — a barge-in in that gap would abort a
  // signal the tool never saw.
  if (beforeExecute) await beforeExecute(input);
  const options: ExecuteToolOptions = {};
  if (call.signal !== undefined) options.signal = call.signal;
  if (call.toolCallId !== undefined) options.toolCallId = call.toolCallId;
  const result = await ctx.executeTool(call.name, input, ctx.sessionId, history, options);
  // AFTER the call, so a tool never reads its own result back, and in
  // COMPLETION order — the only order that is true when sibling calls run
  // concurrently.
  ctx.recordToolResult?.(
    toolResultMessage({ result, toolName: call.name, toolCallId: call.toolCallId }),
  );
  return { input, result, forModel: compactRecordsForModel(result) };
}
