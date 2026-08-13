// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared test helpers for aai-guest.
 *
 * Only what more than one suite needs. The `vi.mock` factories that install
 * the spawn mocks stay per-file — they are hoisted, so they cannot be shared.
 */

import type { ToolDef } from "@alexkroman1/aai";
import { executeToolCall } from "@alexkroman1/aai/runtime";
import type { runNpm } from "./studio-spawn.ts";

/** A settled npm run, defaulting to a clean success. */
export const npmResult = (over: Partial<Awaited<ReturnType<typeof runNpm>>> = {}) => ({
  exitCode: 0 as number | null,
  signal: null as NodeJS.Signals | null,
  stdout: "",
  stderr: "",
  ...over,
});

/**
 * Run one coding-agent tool the way a turn does.
 *
 * The guest's tools are SDK {@link ToolDef}s now, so a spec must not call
 * `execute` directly: the observable behaviour of a tool call includes
 * argument validation, the per-call `ctx`, the deadline, and the conversion
 * of a THROW into an error string the model can read — all of which live in
 * `executeToolCall`, which is what `createTextAgent` dispatches through. A
 * spec that reached past it would be asserting against a path production does
 * not take (and several here depend on exactly that shaping: a path escape is
 * a throw, and it must arrive as text).
 */
export async function runTool(
  tools: Record<string, ToolDef>,
  name: string,
  args: Record<string, unknown> = {},
  overrides: Partial<Parameters<typeof executeToolCall>[2]> = {},
): Promise<string> {
  const tool = tools[name];
  if (!tool) throw new Error(`no such tool: ${name}`);
  return await executeToolCall(name, args, {
    tool,
    env: {},
    sessionId: "test-session",
    ...overrides,
  });
}
