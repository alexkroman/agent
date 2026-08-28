// Copyright 2025 the AAI authors. MIT license.
/**
 * The guest's `run_code` executor and one-shot tool trials (the studio's
 * test_agent), split from harness.ts. Both run OUTSIDE any session: the
 * executor is also wired into the embedded runtime as
 * `RuntimeOptions.runCode`.
 */

import { Worker } from "node:worker_threads";
import { errorMessage, isToolFailure } from "@alexkroman1/aai";
import pTimeout from "p-timeout";
import type { AgentDef, ToolContext } from "./harness-types.ts";
import { RUN_CODE_TIMEOUT_MS, TOOL_TIMEOUT_MS } from "./limits.ts";

// ---- run_code builtin -------------------------------------------------------

/**
 * The body of the worker thread one `run_code` call runs in.
 *
 * A STRING rather than a sibling file, because the harness ships as ONE bundled
 * artifact (`codeSplitting: false`, baked into the snapshot image) and there is
 * no second file for a worker to be started from. The model's code arrives as
 * `workerData`, never spliced into this source — a quote in the agent's program
 * must not be able to end this program.
 *
 * Evaluated as CommonJS, which is what `eval: true` gives; the async IIFE is
 * what lets the model's code use top-level `await`.
 */
const RUN_CODE_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const output = [];
const push = (...args) => output.push(args.map(String).join(" "));
const sandboxConsole = { log: push, info: push, warn: push, error: push, debug: push };
(async () => {
  try {
    const factory = new Function("console", "return (async () => {\\n" + workerData.code + "\\n})();");
    await factory(sandboxConsole);
    parentPort.postMessage({ output });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort.postMessage({ output, error: message });
  }
})();
`;

type RunCodeMessage = { output?: unknown; error?: unknown };

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
 * ## The timeout needs a THREAD to cancel, not a promise to race
 *
 * This used to be a bare `new Function` in the harness process under
 * `pTimeout`. That bounds nothing a timer can outlive, and the returned async
 * IIFE runs SYNCHRONOUSLY up to its first `await` — so a model-authored
 * `while (true) {}`, which has no `await` at all, never yields, and the
 * `pTimeout` timer that was supposed to fire at 5s cannot be reached to fire.
 * It wedged the WHOLE GUEST: `/health` stopped answering, every concurrent
 * voice session on that sandbox stalled, and `createIdleController`'s interval
 * never ticked, so the guest could not even self-exit — it burned to Modal's
 * lifetime cap. Both `limits.ts` and the package guide called the timeout
 * "enforced", and for the class of program most worth bounding it was not.
 *
 * A worker thread is the only thing in Node that can be stopped mid-loop:
 * `terminate()` tears down the isolate whether or not it ever yields. The costs
 * are real and priced in — one isolate spawn (tens of ms) per call, and the
 * loss of shared globals between calls, neither of which any caller depends on.
 *
 * Output is captured through an injected `console` argument rather than a
 * global monkey-patch, so concurrent run_code calls never clobber each other,
 * and it now rides back over `postMessage` from the worker.
 *
 * `timeoutMs` is a test seam. Production always takes {@link RUN_CODE_TIMEOUT_MS}.
 */
export async function runCode(
  code: string,
  timeoutMs: number = RUN_CODE_TIMEOUT_MS,
): Promise<string | { error: string }> {
  let worker: Worker;
  try {
    worker = new Worker(RUN_CODE_WORKER, { eval: true, workerData: { code } });
  } catch (err) {
    return { error: errorMessage(err) };
  }
  const settled = new Promise<RunCodeMessage>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    // Only reachable when the worker died without answering — the model's code
    // called `process.exit`, or an OOM took the isolate. Late `reject` after a
    // `resolve` is a no-op, so the ordinary exit needs no guard.
    worker.once("exit", (exitCode) => {
      reject(new Error(`run_code ended without a result (worker exit ${exitCode})`));
    });
  });
  try {
    const message = await pTimeout(settled, {
      milliseconds: timeoutMs,
      message: `run_code timed out after ${timeoutMs}ms`,
    });
    if (typeof message.error === "string") return { error: message.error };
    const lines = Array.isArray(message.output) ? message.output.map(String) : [];
    const text = lines.join("\n").trim();
    return text || "Code ran successfully (no output)";
  } catch (err) {
    return { error: errorMessage(err) };
  } finally {
    // The whole point on the timeout path; on every other path it also reclaims
    // an isolate whose event loop the model left work pending in (a dangling
    // `setInterval`), which used to keep the HARNESS alive instead.
    void worker.terminate();
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
  opts: { env: Readonly<Record<string, string>> },
): Promise<ToolCallResponse> {
  const state =
    req.state ?? (typeof agent.state === "function" ? structuredClone(agent.state()) : {});

  if (req.name === "run_code") {
    const code = typeof req.args?.code === "string" ? req.args.code : "";
    const result = await runCode(code);
    // `isToolFailure` rather than a hand-written `typeof === "object" && "error"
    // in result`: the object-and-non-null check is exactly what the guard
    // bundles, and it narrows the `string` half of `runCode`'s return the same
    // way. A widened return still fails here at compile time.
    if (isToolFailure(result)) {
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
    // `db` was here, as a lazy getter that threw the enablement guidance — a
    // trial never had storage, and only an ACTUAL access should have failed.
    // `ctx.db` is gone entirely: the platform hands tool code no database, so a
    // tool wanting SQL brings its own client and credential.
    generate: () => Promise.reject(new Error("generate is not available in trial tool runs")),
    delegate: () => Promise.reject(new Error("delegate is not available in trial tool runs")),
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

    const result = await pTimeout(Promise.resolve(tool.execute(parsed, ctx)), {
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
