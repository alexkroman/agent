// Copyright 2025 the AAI authors. MIT license.

import vm from "node:vm";
import { z } from "zod";
import { RUN_CODE_TIMEOUT_MS } from "../sdk/constants.ts";
import type { ToolDef } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";

const SKIPPED_CLASS_KEYS = new Set(["constructor", "prototype", "length", "name"]);

// biome-ignore lint/complexity/noBannedTypes: copying descriptors from arbitrary class constructors
function copyStaticMembers(src: Function, dst: Function): void {
  for (const key of Object.getOwnPropertyNames(src)) {
    if (SKIPPED_CLASS_KEYS.has(key)) continue;
    try {
      const desc = Object.getOwnPropertyDescriptor(src, key);
      if (desc) Object.defineProperty(dst, key, desc);
    } catch {
      // Skip non-configurable properties.
    }
  }
}

/**
 * Prevents sandbox code from reaching the host `Function` constructor via
 * `fn.constructor.constructor('return process')()`. For class constructors
 * we also copy static members and neuter `prototype.constructor` so
 * instances created via `new` cannot escape either.
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

export async function executeInIsolate(code: string): Promise<string | { error: string }> {
  const output: string[] = [];
  const capture = (...args: unknown[]) => output.push(args.map(String).join(" "));

  // Tracked so timers can't fire into the host loop after execution ends.
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

  // Every host function/class is wrapped with neutralizeConstructor to block
  // the `fn.constructor.constructor('return process')()` escape to host Function.
  const context = vm.createContext(
    {
      console: Object.freeze({
        log: neutralizeConstructor(capture),
        info: neutralizeConstructor(capture),
        warn: neutralizeConstructor(capture),
        error: neutralizeConstructor(capture),
        debug: neutralizeConstructor(capture),
      }),
      setTimeout: neutralizeConstructor(sandboxSetTimeout),
      clearTimeout: neutralizeConstructor(sandboxClearTimeout),
      setInterval: neutralizeConstructor(sandboxSetInterval),
      clearInterval: neutralizeConstructor(sandboxClearInterval),
      URL: neutralizeConstructor(URL),
      URLSearchParams: neutralizeConstructor(URLSearchParams),
      TextEncoder: neutralizeConstructor(TextEncoder),
      TextDecoder: neutralizeConstructor(TextDecoder),
      atob: neutralizeConstructor(atob),
      btoa: neutralizeConstructor(btoa),
      structuredClone: neutralizeConstructor(structuredClone),
    },
    {
      codeGeneration: { strings: false, wasm: false },
    },
  );

  try {
    // Async IIFE so user code can use top-level `await`.
    const wrapped = `(async () => {\n${code}\n})()`;
    const script = new vm.Script(wrapped, { filename: "run_code.js" });

    await script.runInContext(context, { timeout: RUN_CODE_TIMEOUT_MS });

    const text = output.join("\n").trim();
    return text || "Code ran successfully (no output)";
  } catch (err: unknown) {
    return { error: errorMessage(err) };
  } finally {
    for (const id of activeTimers) {
      clearTimeout(id);
      clearInterval(id);
    }
    activeTimers.clear();
  }
}
