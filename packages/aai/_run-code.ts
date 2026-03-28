// Copyright 2025 the AAI authors. MIT license.
/**
 * run_code built-in tool — executes user JavaScript in a fresh secure-exec
 * V8 isolate with no network, filesystem writes, or env access.
 */

import { z } from "zod";
import { errorMessage, isReadOnlyFsOp } from "./_utils.ts";
import { RUN_CODE_MEMORY_MB, RUN_CODE_TIMEOUT_MS } from "./constants.ts";
import type { ToolDef } from "./types.ts";

const runCodeParams = z.object({
  code: z.string().describe("JavaScript code to execute. Use console.log() for output."),
});

/**
 * Execute JavaScript code inside a fresh secure-exec V8 isolate.
 *
 * Each invocation spins up a disposable isolate with:
 * - No filesystem writes
 * - No network access
 * - No child process spawning
 * - No environment variable access
 * - 32 MB memory limit
 * - 5 second execution timeout
 *
 * The isolate is disposed immediately after execution, so no state
 * leaks between invocations or across sessions.
 */
export function createRunCode(): ToolDef<typeof runCodeParams> {
  return {
    description:
      "Execute JavaScript code in a secure sandbox and return the output. Use this for calculations, data transformations, string manipulation, or any task that benefits from running code. Output is captured from console.log(). No network or filesystem access.",
    parameters: runCodeParams,
    async execute(args) {
      return executeInIsolate(args.code);
    },
  };
}

/** Lazily import secure-exec to avoid top-level side effects. */
let _secureExecPromise: Promise<typeof import("secure-exec")> | undefined;
function getSecureExec() {
  _secureExecPromise ??= import("secure-exec");
  return _secureExecPromise;
}

// The harness loads user code via readFileSync + AsyncFunction so that syntax
// errors are caught by try/catch rather than causing a silent module-parse failure.
const RUN_CODE_HARNESS = `
import { readFileSync } from "node:fs";

const __output = [];
const __capture = (...args) => __output.push(args.map(String).join(" "));
const __console = {
  log: __capture, info: __capture, warn: __capture,
  error: __capture, debug: __capture,
};
try {
  const __userCode = readFileSync("/app/user-code.js", "utf8");
  const __AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
  const __fn = new __AsyncFn("console", __userCode);
  await __fn(__console);
  const result = __output.join("\\n").trim();
  process.stdout.write(JSON.stringify({ ok: true, result: result || "Code ran successfully (no output)" }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
}
`;

const IsolateOutputSchema = z.object({
  ok: z.boolean(),
  result: z.string().optional(),
  error: z.string().optional(),
});

/** Parse stdout from the run_code harness into a result or error. */
function parseIsolateOutput(stdout: string, stderr: string): string | { error: string } {
  if (!stdout) {
    if (stderr) return { error: stderr.trim() };
    return { error: "Code execution timed out" };
  }
  try {
    const parsed = IsolateOutputSchema.parse(JSON.parse(stdout));
    if (parsed.ok) return parsed.result ?? "Code ran successfully (no output)";
    return { error: parsed.error ?? "Unknown error" };
  } catch {
    return stdout.trim() || "Code ran successfully (no output)";
  }
}

/**
 * Exported for testing — execute user code in a fresh secure-exec V8 isolate.
 */
export async function executeInIsolate(code: string): Promise<string | { error: string }> {
  const {
    createInMemoryFileSystem,
    createNodeDriver,
    createNodeRuntimeDriverFactory,
    NodeRuntime,
  } = await getSecureExec();

  const fs = createInMemoryFileSystem();
  await fs.writeFile("/app/harness.js", RUN_CODE_HARNESS);
  await fs.writeFile("/app/user-code.js", code);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let resolveOutput: (() => void) | null = null;
  const outputReady = new Promise<void>((r) => {
    resolveOutput = r;
  });

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: fs,
      permissions: {
        fs: (req) =>
          isReadOnlyFsOp(req.op)
            ? { allow: true }
            : { allow: false, reason: "Filesystem is read-only" },
        network: () => ({ allow: false, reason: "Network access is disabled in run_code" }),
        childProcess: () => ({ allow: false, reason: "Subprocess spawning is disabled" }),
        env: () => ({ allow: false, reason: "Env access is disabled in run_code" }),
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: RUN_CODE_MEMORY_MB,
    onStdio(event) {
      if (event.channel === "stdout") stdoutChunks.push(event.message);
      if (event.channel === "stderr") stderrChunks.push(event.message);
      resolveOutput?.();
    },
  });

  // Await the exec promise so the isolate completes naturally before disposal.
  // This avoids "Isolate is disposed" rejections from internal secure-exec
  // promises (like ESM compilation) that fire when we dispose mid-execution.
  const execPromise = runtime.exec('import "/app/harness.js";', { cwd: "/app" });

  try {
    // Wait for output (stdout/stderr) or timeout — no polling needed.
    await Promise.race([outputReady, new Promise<void>((r) => setTimeout(r, RUN_CODE_TIMEOUT_MS))]);

    // Let the isolate finish naturally — wait a short grace period for exec
    // to settle after output is captured (avoids disposing mid-execution).
    await Promise.race([
      execPromise.catch(() => {
        // exec may reject on error code paths — already handled by parseIsolateOutput
      }),
      new Promise((r) => setTimeout(r, 200)),
    ]);

    return parseIsolateOutput(stdoutChunks.join(""), stderrChunks.join(""));
  } catch (err: unknown) {
    return { error: errorMessage(err) };
  } finally {
    runtime.dispose();
  }
}
