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
 * **The `"tool"` arm carries what an EARLIER tool answered**, which is the one
 * thing a tool could not see before. Its two extra fields say WHICH call the
 * result belongs to — a bare string cannot, and a tool reading a sibling's
 * output has to know whether it is reading the one it cares about. They are
 * optional because `content` is the only field every arm has, and every reader
 * that predates them (`m.role === "user"` filters, `{ role, content }`
 * projections, the `history.restored` wire frame, which carries user and
 * assistant turns only) keeps working untouched.
 *
 * Read a tool arm by ROLE, never by the presence of a field: a `"tool"` message
 * replayed out of a session's own event log by a resume names the tool it
 * answers, and one from a transport that never recorded the call may not.
 *
 * @public
 */
export type Message = {
  /** The role of the message sender. */
  role: "user" | "assistant" | "tool";
  /**
   * The text content of the message.
   *
   * For a `"tool"` message this is the result the tool returned, already
   * serialized and capped the same way the client's own `tool.completed` frame
   * caps it — so what a tool reads live is what it reads again after a resume,
   * which rebuilds this from that frame.
   */
  content: string;
  /**
   * `role: "tool"` only — the name of the tool whose result `content` is.
   *
   * The name the MODEL calls it by (the registry key), so a tool matching on it
   * uses the same string it would put in `ctx.messages`' own tool schemas.
   */
  toolName?: string;
  /**
   * `role: "tool"` only — the id of the call `content` answers.
   *
   * Pairs with `ToolCallInfo.id` on the client and with `tool.called` /
   * `tool.completed` on the event stream, so a tool can tell two calls of the
   * same tool in one turn apart.
   */
  toolCallId?: string;
};
