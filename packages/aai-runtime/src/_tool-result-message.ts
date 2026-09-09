// Copyright 2026 the AAI authors. MIT license.
/**
 * What a finished tool call contributes to `ctx.messages`.
 *
 * ONE statement of it, for the same reason `historyMessageOf`
 * (`session-event-history.ts`) is the one statement of what a TRANSCRIPT
 * contributes: four producers reach this shape from four different directions —
 * the pipeline's own tool runner (`to-vercel-tools.ts`), the text agent's
 * incoming `ToolModelMessage`s (`text-agent.ts`), the S2S session's tool steps
 * (`session-tool-steps.ts`), and a resume reading the session's event log
 * (`session-event-history.ts`) — and a tool must see the SAME history under
 * `aai dev`, in the sandbox and after a reconnect. Four literals is four
 * chances at a `toolName` that is present live and absent on resume.
 *
 * **The result is CAPPED here, and that is what makes the four agree.** The
 * event log only ever holds `capToolResult(result)` (the wire schema refuses
 * more — see `MAX_TOOL_RESULT_CHARS`), so a live path recording the full string
 * would hand a tool one thing during the call and a shorter thing after a
 * resume, with nothing reporting the difference. The model still gets the whole
 * result: that goes to the provider, not through here.
 */

import type { Message } from "@alexkroman1/aai";
import { capToolResult } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";

/**
 * The `role: "tool"` message one settled call contributes.
 *
 * `toolName` and `toolCallId` are optional on {@link Message} and are omitted
 * rather than set to `undefined` — `exactOptionalPropertyTypes` makes those two
 * different types, and a `{ toolName: undefined }` reaching a `structuredClone`
 * or a JSON round trip is a key that survives one and not the other.
 *
 * @internal
 */
export function toolResultMessage(call: {
  result: string;
  toolName?: string | undefined;
  toolCallId?: string | undefined;
}): Message {
  return {
    role: "tool",
    content: capToolResult(call.result),
    ...omitUndefined({ toolName: call.toolName, toolCallId: call.toolCallId }),
  };
}
