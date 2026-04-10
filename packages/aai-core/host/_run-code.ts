// Copyright 2025 the AAI authors. MIT license.
/**
 * run_code built-in tool — executes user JavaScript in a fresh `node:vm`
 * context with no network, filesystem, or process access.
 */

import vm from "node:vm";
import { z } from "zod";
import { errorMessage } from "../sdk/_utils.ts";
import { RUN_CODE_TIMEOUT_MS } from "../sdk/constants.ts";
import type { ToolDef } from "../sdk/types.ts";

const SKIPPED_CLASS_KEYS = new Set(["constructor", "prototype", "length", "name"]);

/**
 * Copy static members from a class constructor to a wrapper function,
 * skipping built-in keys that must not be forwarded.
 */
// biome-ignore lint/complexity/noBannedTypes: copying descriptors from arbitrary class constructors
function copyStaticMembers(src: Function, dst: Function): void {
  for (const key of Object.getOwnPropertyNames(src)) {
    if (SKIPPED_CLASS_KEYS.has(key)) continue;
    try {
      const desc = Object.getOwnPropertyDescriptor(src, key);
      if (desc) Object.defineProperty(dst, key, desc);
    } catch {
      // Skip non-configurable properties
    }
  }
}

/**
 * Neuter the `.constructor` chain on a host function or class constructor.
 *
 * For plain functions: wraps the function so calling `.constructor` or
 * `.constructor.constructor` no longer exposes the host `Function`.
 *
 * For class constructors: additionally copies static methods and neutralizes
 * `prototype.constructor` so instances created via `new` also cannot escape.
 *
 * This prevents sandbox code from reaching the host `Function` constructor
 * via patterns like `fn.constructor.constructor('return process')()`.
 */
// biome-ignore lint/complexity/noBannedTypes: wrapping arbitrary functions and class constructors
function neutralizeConstructor<T extends Function>(fn: T): T {
  const hasPrototype = typeof fn.prototype === "object" && fn.prototype !== null;

  function Wrapper(this: unknown, ...args: unknown[]) {
    if (hasPrototype) {
      return new (fn as unknown as new (...a: unknown[]) => unknown)(...args);
    }
    return (fn as unknown as (...a: unknown[]) => unknown)(...args);
  }

  if (hasPrototype) {
    copyStaticMembers(fn, Wrapper);
    // Neuter prototype.constructor so instances can't escape either.
    if (Wrapper.prototype) {
      Object.defineProperty(Wrapper.prototype, "constructor", {
        value: undefined,
        writable: false,
        configurable: false,
      });
    }
  }

  Object.defineProperty(Wrapper, "constructor", {
    value: undefined,
    writable: false,
    configurable: false,
  });

  return Wrapper as unknown as T;
}

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

  const context = vm.createContext(
    {
      // Console methods wrapped to prevent .constructor escape to host Function.
      console: Object.freeze({
        log: neutralizeConstructor(capture),
        info: neutralizeConstructor(capture),
        warn: neutralizeConstructor(capture),
        error: neutralizeConstructor(capture),
        debug: neutralizeConstructor(capture),
      }),
      // Wrapped timers — neutralized to prevent .constructor escape.
      setTimeout: neutralizeConstructor(sandboxSetTimeout),
      clearTimeout: neutralizeConstructor(sandboxClearTimeout),
      setInterval: neutralizeConstructor(sandboxSetInterval),
      clearInterval: neutralizeConstructor(sandboxClearInterval),
      // Standard web-compat globals — constructor chain neutered.
      URL: neutralizeConstructor(URL),
      URLSearchParams: neutralizeConstructor(URLSearchParams),
      TextEncoder: neutralizeConstructor(TextEncoder),
      TextDecoder: neutralizeConstructor(TextDecoder),
      atob: neutralizeConstructor(atob),
      btoa: neutralizeConstructor(btoa),
      structuredClone: neutralizeConstructor(structuredClone),
    },
    {
      // Block string-based code generation within the sandbox realm.
      codeGeneration: { strings: false, wasm: false },
    },
  );

  try {
    // Wrap user code in an async IIFE so top-level `await` works.
    const wrapped = `(async () => {\n${code}\n})()`;
    const script = new vm.Script(wrapped, { filename: "run_code.js" });

    // runInContext's `timeout` enforces the execution limit.
    const result = await script.runInContext(context, { timeout: RUN_CODE_TIMEOUT_MS });
    void result;

    const text = output.join("\n").trim();
    return text || "Code ran successfully (no output)";
  } catch (err: unknown) {
    return { error: errorMessage(err) };
  } finally {
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
