// Copyright 2025 the AAI authors. MIT license.
/**
 * The guest's `run_code` executor and one-shot tool trials (the studio's
 * test_agent), split from harness.ts. Both run OUTSIDE any session: the
 * executor is also wired into the embedded runtime as
 * `RuntimeOptions.runCode`.
 */

import { dbAdapter, errMsg, withTimeout } from "./harness-rpc.ts";
import type { AgentDef, ToolContext } from "./harness-types.ts";
import { RUN_CODE_TIMEOUT_MS, STORAGE_DISABLED_MESSAGE, TOOL_TIMEOUT_MS } from "./limits.ts";

// ---- run_code builtin -------------------------------------------------------

/**
 * Execute agent-supplied JavaScript for the `run_code` builtin — wired into
 * the runtime as `RuntimeOptions.runCode`, and run directly for one-shot
 * trials.
 *
 * `run_code` runs HERE, inside the guest. The Modal sandbox IS the security
 * boundary — code here has the same authority as the rest of the sandboxed
 * agent bundle and nothing more; an escape lands in a container that is
 * already confined and network-restricted.
 *
 * Output is captured through an injected `console` argument rather than a
 * global monkey-patch, so concurrent run_code calls never clobber each other.
 */
export async function runCode(code: string): Promise<string | { error: string }> {
  const output: string[] = [];
  const push = (...args: unknown[]) => output.push(args.map(String).join(" "));
  const sandboxConsole = { log: push, info: push, warn: push, error: push, debug: push };

  try {
    // Async wrapper so user code can use top-level `await`.
    const factory = new Function("console", `return (async () => {\n${code}\n})();`) as (
      c: typeof sandboxConsole,
    ) => Promise<unknown>;

    await withTimeout(factory(sandboxConsole), RUN_CODE_TIMEOUT_MS, "run_code");

    const text = output.join("\n").trim();
    return text || "Code ran successfully (no output)";
  } catch (err) {
    return { error: errMsg(err) };
  }
}

// ---- One-shot tool trials (studio test_agent) -------------------------------

export type ToolCallRequest = {
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  /** Trial state — `null` initializes from the agent's `state()` factory. */
  state: Record<string, unknown> | null;
};

type ToolCallResponse = {
  result?: string;
  error?: string;
  state: Record<string, unknown>;
};

/**
 * Run one tool call outside any session — the studio's test_agent trial.
 * Deliberately minimal context: no client to `send` to, no history, and
 * ctx.db/ctx.generate report their platform semantics.
 */
export async function executeTool(
  agent: AgentDef,
  req: ToolCallRequest,
  opts: { storageEnabled: boolean; env: Readonly<Record<string, string>> },
): Promise<ToolCallResponse> {
  const state =
    req.state ?? (typeof agent.state === "function" ? structuredClone(agent.state()) : {});

  if (req.name === "run_code") {
    const code = typeof req.args?.code === "string" ? req.args.code : "";
    const result = await runCode(code);
    if (typeof result === "object" && result !== null && "error" in result) {
      return { error: result.error, state };
    }
    return { result, state };
  }

  const tool = agent.tools[req.name];
  if (!tool) {
    return { error: `Unknown tool: ${req.name}`, state };
  }

  const ctx: ToolContext = {
    env: opts.env,
    state,
    // Lazy getter: only an actual ctx.db access should fail when storage is
    // disabled — constructing the context must not.
    get db() {
      if (!opts.storageEnabled) throw new Error(STORAGE_DISABLED_MESSAGE);
      return dbAdapter;
    },
    generate: () => Promise.reject(new Error("generate is not available in trial tool runs")),
    messages: [],
    sessionId: req.sessionId,
    send: () => {
      /* no connected client in a trial run */
    },
  };

  try {
    // Parse inside the try: invalid LLM-supplied args must surface as a
    // `{ error }` tool result (which the LLM can repair), not as a JSON-RPC
    // protocol error.
    const parsed =
      tool.parameters && typeof tool.parameters.parse === "function"
        ? tool.parameters.parse(req.args)
        : req.args;

    const result = await withTimeout(
      Promise.resolve(tool.execute(parsed, ctx)),
      TOOL_TIMEOUT_MS,
      `Tool "${req.name}"`,
    );
    return {
      result: typeof result === "string" ? result : JSON.stringify(result),
      state,
    };
  } catch (err) {
    return { error: errMsg(err), state };
  }
}
