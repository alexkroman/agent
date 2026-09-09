// Copyright 2026 the AAI authors. MIT license.
/**
 * The AI SDK's `ModelMessage` list, projected into the `{ role, content }` view
 * `ctx.messages` promises a tool.
 *
 * Split out of `text-agent.ts` at the source-length cap. It is a coherent unit
 * rather than an arbitrary cut: every function here answers one question — what
 * does a TOOL see of this conversation — and the answer is the same three-role
 * `Message` union the pipeline and the session both produce, which is why the
 * `"tool"` arm goes through `toolResultMessage()` like every other producer of
 * it (see `_tool-result-message.ts`).
 *
 * @module
 */

import type { Message } from "@alexkroman1/aai";
import type { ModelMessage, ToolModelMessage, ToolResultPart } from "ai";
import { toolResultMessage } from "./_tool-result-message.ts";

/**
 * What one `tool-result` part says, as the string a tool body would read.
 *
 * The AI SDK models a result as a TAGGED output rather than a string, and the
 * five shapes are not interchangeable: `text`/`error-text` already are one,
 * `json`/`error-json` have to be serialized (which is the form this SDK's own
 * executor produces anyway — `ExecuteTool` answers a string), `content` is a
 * multimodal array whose text parts are the readable half, and
 * `execution-denied` carries no result at all because none was produced.
 *
 * The error arms are NOT dropped. A tool that failed is exactly what a later
 * tool most wants to know about, and this SDK's own failures already arrive as
 * an ordinary result (`serializeToolFailure`) rather than as a distinct arm.
 */
export function toolOutputText(output: ToolResultPart["output"]): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "content":
      // The same "keep the text parts, join them" rule the message bodies get
      // — one function, so a part shape that starts counting as words counts
      // in both places.
      return textOf(output.value);
    default:
      // `execution-denied` — no result exists, so the reason IS the result.
      return output.reason ?? "Tool execution denied.";
  }
}

/**
 * Project the turn's messages into the `{ role, content }` shape
 * `ctx.messages` promises a tool.
 *
 * Text content only, and joined across parts: `ctx.messages` is documented as
 * conversation CONTEXT for a tool to read, and a tool reading it wants the
 * words. Non-text parts (an image) have no string form that belongs in that
 * field, and the roles narrow to the three the public {@link Message} type
 * declares — a `system` message is the agent's own prompt, which a tool does
 * not need handed back to it.
 *
 * **A `tool` message is projected PART BY PART, and that is the whole of the
 * `"tool"` arm on the incoming side.** It carries `tool-result` parts and never
 * a `text` one, so the text-only rule above dropped every one of them and a
 * caller resuming a conversation handed its tools a history with every result
 * missing — while the model reading the same list saw them all. One message per
 * part, because the pairing a tool needs is result-to-CALL and a `tool` message
 * can answer several calls at once.
 *
 * An assistant message that is only `tool-call` parts still contributes
 * nothing: the CALL is not information a later tool can act on, and the result
 * that answers it arrives one message later carrying the tool's name anyway.
 */
export function toContextMessages(messages: readonly ModelMessage[]): readonly Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      out.push(...toolResultsOf(message.content));
      continue;
    }
    const content = textOf(message.content);
    if (content !== "") out.push({ role: message.role, content });
  }
  return out;
}

/** The `tool` messages one `ToolModelMessage`'s content contributes. */
function toolResultsOf(content: ToolModelMessage["content"]): Message[] {
  const out: Message[] = [];
  for (const part of content) {
    if (part.type !== "tool-result") continue;
    out.push(
      toolResultMessage({
        result: toolOutputText(part.output),
        toolName: part.toolName,
        toolCallId: part.toolCallId,
      }),
    );
  }
  return out;
}

/**
 * A part of a message body, as far as reading its WORDS is concerned.
 *
 * Structural rather than one of the SDK's unions, because {@link textOf} is
 * asked the same question about three of them — a user body, an assistant body,
 * and a `content` tool output, whose `media` arm belongs to none of the other
 * two. Every one of them is "parts, some of which are text".
 */
type TextualPart = { readonly type: string; readonly text?: string | undefined };

/** The words of a message body, joined across its parts. */
function textOf(content: string | readonly TextualPart[]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    .join("");
}
