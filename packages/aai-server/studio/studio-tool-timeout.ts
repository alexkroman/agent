// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-call timeout for the coding agent's tools.
 *
 * A tool call that never settles — a sandbox RPC whose harness died, a docs
 * MCP server that accepted the request and went silent, a web fetch stuck in
 * a stalled body read — used to hang the whole chat turn: the UI shows the
 * tool row shimmering forever and the stream never finishes. Wrapping every
 * tool's `execute` in a deadline turns that hang into an ordinary tool-result
 * error the model can react to (and the UI renders as a completed call).
 *
 * The timeout is a resolution race, not a cancellation: the underlying work
 * may keep running until the turn's teardown (`disposeSandbox` / MCP close)
 * kills its transport. That's acceptable — the point is the conversation
 * stays live.
 */

import type { Tool, ToolSet } from "ai";

/**
 * Generous by design: `test_agent` runs a full Vite build plus a sandbox
 * load, which can take tens of seconds cold. Override per host with
 * `STUDIO_TOOL_TIMEOUT_MS`.
 */
export const DEFAULT_STUDIO_TOOL_TIMEOUT_MS = 120_000;

/** Resolve the per-call tool deadline from host env. */
export function studioToolTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.STUDIO_TOOL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STUDIO_TOOL_TIMEOUT_MS;
}

function timeoutMessage(name: string, timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return (
    `Error: ${name} timed out after ${seconds}s and was abandoned. ` +
    "Do not assume it succeeded — retry it, or tell the user it is not responding."
  );
}

/**
 * Wrap every executable tool in `tools` so a call that outlives `timeoutMs`
 * resolves to an error string instead of hanging the turn. Tools without an
 * `execute` (none today) pass through untouched. Generic so the caller's
 * tool-set shape (and per-tool key knowledge) survives the wrap.
 */
export function withToolTimeouts<T extends ToolSet>(
  tools: T,
  timeoutMs = studioToolTimeoutMs(),
): T {
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute;
    if (!execute) {
      out[name] = t;
      continue;
    }
    const wrapped: Tool["execute"] = (args, opts) => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(timeoutMessage(name, timeoutMs)), timeoutMs);
      });
      const run = Promise.resolve(execute(args, opts));
      // If the deadline wins, the eventual rejection of the abandoned call
      // must not surface as an unhandled rejection.
      run.catch(() => undefined);
      return Promise.race([run, deadline]).finally(() => clearTimeout(timer));
    };
    out[name] = { ...t, execute: wrapped } as Tool;
  }
  return out as T;
}
