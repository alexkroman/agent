// Copyright 2026 the AAI authors. MIT license.
/**
 * The leaf types `ToolContext` and `AgentDef` both need.
 *
 * A module of its own purely to break an import CYCLE: `types.ts` uses
 * `ToolContext` (in `ToolDef.execute`) while `tool-context.ts` needs these three
 * declarations, and a cycle between them does not surface as an error — it
 * degrades `ToolDef`'s state parameter until two tools with incompatible state
 * shapes are mutually assignable. `define.test-d.ts` catches that; this file is
 * why it does not happen. All three are re-exported from `types.ts` and the
 * package root, so nothing imports them from here.
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

/**
 * Default type of `ctx.state` when an agent does not declare one — `any`, so
 * untyped state access compiles. Opt into real checking by annotating the
 * context (`ctx: ToolContext<Cart>`), which also makes the agent verify the
 * tool against its own state shape.
 *
 * @remarks
 * `any` deliberately, not `Record<string, unknown>`: session state is a
 * genuinely dynamic bag created by the agent's `state` factory, and `tool()`
 * can only learn its real shape from an annotated context. The stricter
 * default made the ordinary spelling
 * (`execute: (a, ctx) => ctx.state.cart.push(a)`) a compile error even
 * though it runs correctly — and once `aai build`/`aai deploy` started
 * running the project's own `tsc`, that refused to publish working agents
 * without catching bugs.
 *
 * @public
 */
export type DefaultSessionState = any;

/**
 * Default type of a tool result observed on the client (`useToolResult`) —
 * `any`, so untyped reads compile. Pass the shape —
 * `useToolResult<Quote>("get_quote", …)` — for real checking.
 *
 * @remarks
 * The client half of {@link DefaultSessionState}'s problem, and `any` for
 * the same reason: a tool result is the author's own return value
 * round-tripped through JSON — the client already knows its shape, and the
 * framework cannot. The strict default (`unknown`) made reading one field a
 * compile error in a client that runs correctly, which blocked publishing
 * once `aai build` type-checked.
 *
 * @public
 */
export type DefaultToolResult = any;
