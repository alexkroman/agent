// Copyright 2025 the AAI authors. MIT license.
/**
 * The guest's `run_code` executor and one-shot tool trials (the studio's
 * test_agent), split from harness.ts. Both run OUTSIDE any session: the
 * executor is also wired into the embedded runtime as
 * `RuntimeOptions.runCode`.
 */

import { errorMessage } from "@alexkroman1/aai";
import pTimeout from "p-timeout";
import type { AgentDef, ToolContext, ToolDef } from "./harness-types.ts";
import { toolDefInput, toolDefRun } from "./harness-types.ts";
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

    await pTimeout(factory(sandboxConsole), {
      milliseconds: RUN_CODE_TIMEOUT_MS,
      message: `run_code timed out after ${RUN_CODE_TIMEOUT_MS}ms`,
    });

    const text = output.join("\n").trim();
    return text || "Code ran successfully (no output)";
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// ---- One-shot tool trials (studio test_agent) -------------------------------

/**
 * Validate a trial's args against the tool's own `input` schema.
 *
 * Throws on an invalid value, because the caller runs this inside the try that
 * turns a throw into a `{ error }` tool result — an invalid argument is
 * something the model repairs, not a JSON-RPC protocol failure. A tool with no
 * schema takes the args through unchanged, as the session path does.
 */
async function validateTrialArgs(tool: ToolDef, args: unknown): Promise<unknown> {
  const schema = toolDefInput(tool);
  if (!schema) return args;
  const parsed = await schema["~standard"].validate(args ?? {});
  if (parsed.issues) {
    throw new Error(`Invalid arguments: ${parsed.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.value;
}

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
  opts: { env: Readonly<Record<string, string>> },
): Promise<ToolCallResponse> {
  const state =
    req.state ?? (typeof agent.state === "function" ? structuredClone(agent.state()) : {});

  if (req.name === "run_code") {
    const code = typeof req.args?.code === "string" ? req.args.code : "";
    const result = await runCode(code);
    // No null check: `runCode` returns `string | { error: string }`, so the
    // typeof narrows it fully. A widened return would fail the `in` below at
    // compile time rather than throwing here.
    if (typeof result === "object" && "error" in result) {
      return { error: result.error, state };
    }
    return { result, state };
  }

  const tool = agent.tools[req.name];
  if (!tool) {
    return { error: `Unknown tool: ${req.name}`, state };
  }
  const run = toolDefRun(tool);
  if (!run) {
    return { error: `Tool "${req.name}" has no \`run\` function`, state };
  }

  const ctx: ToolContext = {
    env: opts.env,
    state,
    // Lazy getter: only an actual ctx.db access should fail — constructing
    // the context must not. Trials always run without storage (a real
    // session's ctx.db is the bundle runtime's own DATABASE_URL connection;
    // the harness has no database client of its own).
    get db(): never {
      throw new Error(STORAGE_DISABLED_MESSAGE);
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
    const parsed = await validateTrialArgs(tool, req.args);

    const result = await pTimeout(Promise.resolve(run(parsed, ctx)), {
      milliseconds: TOOL_TIMEOUT_MS,
      message: `Tool "${req.name}" timed out after ${TOOL_TIMEOUT_MS}ms`,
    });
    return {
      result: typeof result === "string" ? result : JSON.stringify(result),
      state,
    };
  } catch (err) {
    return { error: errorMessage(err), state };
  }
}
