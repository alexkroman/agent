// Copyright 2026 the AAI authors. MIT license.
/**
 * The `send_message` builtin — registered only when the agent declares a
 * send channel (`send: slack()`), not name-listable via `builtinTools`:
 * without a channel there is nothing to send to. Executes host-side in
 * sandbox mode (like the network builtins), with the runtime's SSRF-guarded
 * fetch behind the sender.
 */

import { z } from "zod";
import { type ToolSchema, toToolJsonSchema } from "../sdk/_internal-types.ts";
import type { Sender } from "../sdk/providers.ts";
import type { ToolDef } from "../sdk/types.ts";

/** Name of the builtin registered when the agent declares a `send:` channel. */
export const SEND_MESSAGE_TOOL = "send_message";

const sendMessageParams = z.object({
  text: z.string().min(1).describe("The message text to send to the channel"),
});

/** Resolved send builtin: definition plus its precomputed schema. */
export function resolveSendBuiltin(sender: Sender): {
  def: ToolDef<typeof sendMessageParams>;
  schema: ToolSchema;
} {
  const def: ToolDef<typeof sendMessageParams> = {
    description:
      `Send a message to the agent's configured outbound channel (${sender.name}). ` +
      "Use when the user asks to send, post, share, or notify someone of something.",
    parameters: sendMessageParams,
    async execute(args, ctx) {
      await sender.send(args.text, { signal: ctx.signal });
      return { sent: true, channel: sender.name };
    },
  };
  return {
    def,
    schema: {
      type: "function",
      name: SEND_MESSAGE_TOOL,
      description: def.description,
      parameters: toToolJsonSchema(sendMessageParams) as ToolSchema["parameters"],
    },
  };
}
