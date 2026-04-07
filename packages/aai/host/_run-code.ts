// Copyright 2025 the AAI authors. MIT license.
/**
 * run_code built-in tool — executes user JavaScript in a fresh `node:vm`
 * context with no network, filesystem, or process access.
 */

import vm from "node:vm";
import { z } from "zod";
import { errorMessage } from "../isolate/_utils.ts";
import { RUN_CODE_TIMEOUT_MS } from "../isolate/constants.ts";
import type { ToolDef } from "../isolate/types.ts";

const runCodeParams = z.object({
  code: z.string().describe("JavaScript code to execute. Use console.log() for output."),
});

/**
 * Execute JavaScript code inside a fresh `node:vm` context.
 *
 * Each invocation creates a disposable VM context with:
 * - No filesystem access (`node:fs` and other built-ins unavailable)
 * - No network access (`fetch`, `http` unavailable)
 * - No child process spawning
 * - No environment variable access (`process` unavailable)
 * - Execution timeout (default 5 s)
 *
 * The context is discarded after execution, so no state leaks between
 * invocations or across sessions.
 */
export function createRunCode(): ToolDef<typeof runCodeParams> & { guidance: string } {
  return {
    guidance:
      "You MUST use the run_code tool for ANY question involving math, counting, calculations, " +
      "data processing, or code. NEVER do mental math or recite code verbally. " +
      "run_code executes JavaScript (not Python). Always write JavaScript.",
    description:
      "Execute JavaScript code in a sandbox and return the output. Use this for calculations, data transformations, string manipulation, or any task that benefits from running code. Output is captured from console.log(). No network or filesystem access.",
    parameters: runCodeParams,
    async execute(args) {
      return executeInIsolate(args.code);
    },
  };
}

/**
 * Execute user code in a fresh `node:vm` context.
 *
 * @remarks
 * The VM context only exposes standard ECMAScript globals and a console
 * object that captures output. Node.js APIs (`process`, `require`,
 * `import()`) are not available inside the sandbox.
 */
export async function executeInIsolate(code: string): Promise<string | { error: string }> {
  const output: string[] = [];
  const capture = (...args: unknown[]) => output.push(args.map(String).join(" "));

  // Prevent timer callbacks from leaking into host event loop after execution.
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();

  const sandboxSetTimeout = (
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): ReturnType<typeof setTimeout> => {
    const id = setTimeout(
      (...a: unknown[]) => {
        activeTimers.delete(id);
        fn(...a);
      },
      delay,
      ...args,
    );
    activeTimers.add(id);
    return id;
  };

  const sandboxClearTimeout = (id?: ReturnType<typeof setTimeout>): void => {
    if (id !== undefined) {
      activeTimers.delete(id);
      clearTimeout(id);
    }
  };

  const sandboxSetInterval = (
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): ReturnType<typeof setInterval> => {
    const id = setInterval(fn, delay, ...args);
    activeTimers.add(id);
    return id;
  };

  const sandboxClearInterval = (id?: ReturnType<typeof setInterval>): void => {
    if (id !== undefined) {
      activeTimers.delete(id);
      clearInterval(id);
    }
  };

  const context = vm.createContext({
    console: {
      log: capture,
      info: capture,
      warn: capture,
      error: capture,
      debug: capture,
    },
    // Wrapped timers that track IDs for cleanup in the finally block.
    setTimeout: sandboxSetTimeout,
    clearTimeout: sandboxClearTimeout,
    setInterval: sandboxSetInterval,
    clearInterval: sandboxClearInterval,
    // Standard web-compat globals
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    structuredClone,
    queueMicrotask,
  });

  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Wrap user code in an async IIFE so top-level `await` works.
    const wrapped = `(async () => {\n${code}\n})()`;
    const script = new vm.Script(wrapped, { filename: "run_code.js" });

    // runInContext applies `timeout` to synchronous execution. For the
    // async case we also race against a timer.
    const promise = script.runInContext(context, { timeout: RUN_CODE_TIMEOUT_MS });

    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        raceTimer = setTimeout(
          () => reject(new Error("Code execution timed out")),
          RUN_CODE_TIMEOUT_MS,
        );
      }),
    ]);

    const text = output.join("\n").trim();
    return text || "Code ran successfully (no output)";
  } catch (err: unknown) {
    return { error: errorMessage(err) };
  } finally {
    if (raceTimer) clearTimeout(raceTimer);
    // Cancel all sandbox timers that are still pending. This prevents
    // setInterval/setTimeout callbacks from running in the host event loop
    // after the sandbox execution has completed or timed out.
    for (const id of activeTimers) {
      clearTimeout(id);
      clearInterval(id);
    }
    activeTimers.clear();
  }
}
