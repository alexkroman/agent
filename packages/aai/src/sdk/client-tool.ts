// Copyright 2026 the AAI authors. MIT license.
/**
 * A tool the BROWSER runs: the model calls it like any other, the connected
 * page executes it, and the page's answer is the call's result.
 *
 * The wire already had both halves — every tool call reaches the client as a
 * `tool.called` event carrying its `toolCallId`, and `tool_result` is the
 * client→server command that answers one (host mode has spoken it since it
 * existed). What an `agent.ts` lacked was a way to say "this one is answered by
 * the page", so `ctx.send` was the only reach into the browser and it cannot be
 * awaited. `aai-ui`'s `useClientTool(name, handler)` is the other end.
 *
 * A BRAND on an ordinary {@link ToolDef}, not a second kind of tool, so every
 * surface that reads a tool — `tools/<name>.ts` discovery, schemas, `messages`,
 * `onError`, `when`-gated dialogs, the API report — takes it unchanged.
 *
 * The WAIT rides the call's context, not the def: the runtime that owns a
 * browser session binds it to the `ToolContext` it builds, and this `execute`
 * calls it. So a wrapper that gates a tool by calling `def.execute(args, ctx)`
 * — a persona's owner check, a dialog's `when` — still runs its gate first.
 * Anything with no session to bind one (a text agent, a subagent,
 * `createToolContext` in a spec) runs the same `execute`, which fails naming why.
 *
 * The brand and the per-call wait are registered boundary keys
 * (`_boundary.ts`): an agent bundle and the runtime executing it can each carry
 * their own copy of this module — by design, see that module — so both are
 * registry symbols, and the brand's value is plain data the reader re-checks.
 */

import { readBrand, setBrand } from "./_boundary.ts";
import { isRecord } from "./is-record.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext } from "./tool-context.ts";
import type { ToolDef } from "./tool-def.ts";

/**
 * Wait for the page's answer to THIS call — bound per call by the runtime,
 * which alone knows the session and the `toolCallId`.
 *
 * @internal
 */
export type ClientToolCall = (signal: AbortSignal) => Promise<unknown>;

/**
 * What {@link clientTool} takes: a {@link ToolDef} without `execute`, because the
 * page is the execute.
 *
 * @typeParam P - The tool's input schema — what the page's handler receives.
 *
 * @public
 */
export type ClientToolDef<P extends ToolInputSchema = ToolInputSchema> = Omit<
  ToolDef<P>,
  "execute"
> & {
  /**
   * How long the call waits for the page to answer before it fails, in ms.
   * Defaults to the agent's ordinary tool deadline (`TOOL_EXECUTION_TIMEOUT_MS`,
   * 30 000). Raise it for a handler that waits on the PERSON — a confirmation
   * dialog, a file picker — rather than on the browser.
   */
  timeoutMs?: number;
};

/** The brand's value, as the runtime reads it. @internal */
export type ClientToolBrand = { timeoutMs: number | undefined };

/**
 * Define a tool the connected browser executes.
 *
 * The model sees an ordinary tool. When it calls one, the page's
 * `useClientTool(name, handler)` (from `@alexkroman1/aai-ui`) runs with the
 * validated arguments, and whatever the handler returns — JSON-serialized — is
 * the result the model reads. A handler that throws is a failed call the model
 * is told about, exactly as a server tool's throw is. The call fails the same
 * way when no page answers within `timeoutMs`, or when the turn is cancelled.
 *
 * Only a voice/browser session can answer one. A text agent, a subagent, or a
 * spec calling `execute` directly gets a failure naming the tool.
 *
 * @example `tools/get_location.ts`, answered by the page
 * ```ts
 * import { clientTool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default clientTool({
 *   description: "Get the caller's current location from their browser",
 *   inputSchema: z.object({}),
 *   timeoutMs: 20_000,
 * });
 * ```
 * ```tsx
 * // client.tsx
 * import { useClientTool } from "@alexkroman1/aai-ui";
 *
 * function Location() {
 *   useClientTool("get_location", () =>
 *     new Promise((resolve, reject) =>
 *       navigator.geolocation.getCurrentPosition(
 *         (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
 *         (err) => reject(new Error(err.message)),
 *       ),
 *     ),
 *   );
 *   return null;
 * }
 * ```
 *
 * @public
 */
export function clientTool<P extends ToolInputSchema = ToolInputSchema>(
  def: ClientToolDef<P>,
): ToolDef<P> {
  const { timeoutMs, ...rest } = def;
  const brand: ClientToolBrand = { timeoutMs };
  const tool: ToolDef<P> = {
    ...rest,
    execute(_args: InferSchemaOutput<P>, ctx: ToolContext): Promise<unknown> {
      const call = readBrand(ctx, "clientToolCall");
      if (typeof call !== "function") {
        throw new Error(
          "This is a clientTool: the connected browser page runs it (useClientTool), and this call has no browser session to answer it.",
        );
      }
      return (call as ClientToolCall)(ctx.signal);
    },
  };
  // Enumerable, so a spread of the def (a persona or dialog wrapper) keeps it.
  setBrand(tool, "clientTool", brand, { enumerable: true });
  return tool;
}

/**
 * Bind this call's wait to the context its tool runs with. Non-enumerable, so
 * nothing that copies a context (a spread, a log) carries it along.
 *
 * @internal
 */
export function bindClientToolCall(ctx: ToolContext, call: ClientToolCall): void {
  setBrand(ctx, "clientToolCall", call);
}

/**
 * The brand {@link clientTool} put on `tool`, or undefined for a server tool.
 *
 * @internal
 */
export function clientToolBrand(tool: ToolDef): ClientToolBrand | undefined {
  const brand = readBrand(tool, "clientTool");
  if (!isRecord(brand)) return undefined;
  return { timeoutMs: typeof brand.timeoutMs === "number" ? brand.timeoutMs : undefined };
}
