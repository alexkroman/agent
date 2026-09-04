// Copyright 2026 the AAI authors. MIT license.
/**
 * `requireEnv` — read a credential off `ctx.env`, failing by NAME.
 *
 * Its own module rather than a function in `tool-context.ts`, for two reasons
 * that agree. `tool-context.ts` declares the capability bag and nothing else,
 * and `guard-invariants` rule 24 counts what looks like a field on it — a
 * function whose parameter list mentions `env` reads as two more, which is the
 * rule doing its job on a file that had stopped being only a type. And the
 * one-thing-per-module split is what `tool-def.ts` beside it already does.
 */

import { missingEnvMessage } from "./_missing-env.ts";

/**
 * Read a variable off {@link ToolContext.env}, failing by NAME when it is not set.
 *
 * The `ToolContext` twin of `requireStepEnv`, and there for the same reason: a
 * missing credential is not transient, so it should say which key and how to
 * set it rather than surface as a `TypeError` on the first property access —
 * which `tool-executor.ts` serializes and hands to the MODEL, so what a caller
 * hears is the agent apologising for something no log line explains.
 *
 * ```ts no-check
 * export default tool({
 *   description: "Look up a note",
 *   inputSchema: z.object({ id: z.string() }),
 *   async execute({ id }, ctx) {
 *     const key = requireEnv(ctx, "NOTES_API_KEY");
 *     return await fetch(`https://notes.example.com/${id}`, {
 *       headers: { authorization: `Bearer ${key}` },
 *     }).then((r) => r.json());
 *   },
 * });
 * ```
 *
 * @public
 */
export function requireEnv(
  ctx: { env: Readonly<Partial<Record<string, string>>> },
  name: string,
): string {
  const value = ctx.env[name];
  if (!value) {
    throw new Error(missingEnvMessage(name));
  }
  return value;
}
