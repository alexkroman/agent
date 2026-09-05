// Copyright 2026 the AAI authors. MIT license.
/**
 * What a CONVERSATION message is — the smallest of the pieces split out of
 * `types.ts` as that file reached the 500-line cap, and the fifth to go
 * (`agent-defaults.ts`, `builtin-tools.ts`, `tool-context.ts` and `tool-def.ts`
 * went before it).
 *
 * The seam is the one a reader already uses: everything left in `types.ts` is
 * about what an AGENT is, and this is about what the agent is looking at. It is
 * also the type with the most readers outside that file — `ToolContext.messages`,
 * the transports' history views, `ExecuteTool` — none of which care about
 * `AgentDef` at all.
 *
 * `types.ts` re-exports it, so every existing import is unchanged.
 */

/**
 * A single message in the conversation history.
 *
 * Messages are passed to tool `execute` functions via
 * {@link ToolContext.messages} to provide conversation context.
 *
 * @public
 */
export type Message = {
  /** The role of the message sender. */
  role: "user" | "assistant" | "tool";
  /** The text content of the message. */
  content: string;
};
