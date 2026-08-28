// Copyright 2026 the AAI authors. MIT license.
/**
 * A `run_code` executor for an EVAL, backed by `node:vm`.
 *
 * The `run_code` builtin refuses unless the host supplies a
 * {@link RunCodeExecutor}: a deployed agent runs it only inside the Modal
 * Sandbox, the container is the security boundary, and off-platform there is
 * none — so declining beats evaluating model-written JavaScript in the host
 * process. That is right, and it left every template whose whole subject is
 * "does this agent ANSWER by running code" able to assert the CALL and never the
 * answer: a `toBeDefined()` on the result is satisfied by the refusal string
 * itself.
 *
 * So four template evals — `code-interpreter`, `math-buddy`, `night-owl` and
 * `personal-finance` — each wrote the same eleven lines: a `runInNewContext`
 * with a capturing `console.log`, a one-second timeout, and `errorMessage` on
 * the throw. Byte-identical in all four, comment included. This is that, once,
 * and all four now call it.
 *
 * **They did not, for a while, and the gap was invisible.** This module shipped
 * with its argument written and the four copies left in place, so the dedupe
 * existed and had no consumer — a state no gate can see: `knip` counts the
 * barrel re-export as a use, and the template-coverage ratchet records an
 * unexercised export without judging it. An extraction is finished when the
 * copies are GONE, not when the replacement compiles.
 *
 * **The wrong version was easy to write two ways**, and both were in the copies:
 *
 * 1. **Forgetting the timeout.** `runInNewContext(code, sandbox)` with no
 *    `timeout` lets `while (true) {}` from a model hang the case to the suite
 *    deadline, which reads as a broken harness rather than as a model that
 *    emitted a loop. It is a REQUIRED-by-default here, not an option a copy can
 *    omit.
 * 2. **Letting the throw escape.** A `SyntaxError` from generated code is a
 *    finding about the model, not a failure of the eval, and the builtin's own
 *    contract says so — its return type admits `{ error }` precisely so a
 *    failed evaluation goes BACK to the model, which may then fix it. A copy
 *    that let the throw propagate would fail the case on the agent's first typo.
 *
 * **It is NOT a sandbox and does not pretend to be one.** `node:vm` is an
 * isolation boundary for *accidents*, not for adversaries — a context can reach
 * the host realm through any object handed into it, so `globals` is the one knob
 * and everything in it is a capability grant. A deployed agent still gets the
 * refusal; this exists so a developer's own machine can see what the code
 * printed.
 *
 * @module
 */

import { runInNewContext } from "node:vm";
import type { RunCodeExecutor } from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";

/** How long generated code may run before the context is torn down. */
const DEFAULT_TIMEOUT_MS = 1000;

/** What {@link createVmRunCode} takes. */
export type VmRunCodeOptions = {
  /**
   * Wall-clock budget for one evaluation, in milliseconds. Defaults to 1000.
   *
   * A `while (true) {}` is a thing a model emits, and without this the case
   * hangs to the suite deadline and reads as a broken harness.
   */
  readonly timeoutMs?: number;
  /**
   * Extra globals the evaluated code may see, merged over the capturing
   * `console`.
   *
   * Every entry is a CAPABILITY GRANT into a context that can reach the host
   * realm through any object it is handed, so add one deliberately. The default
   * is `console.log` and nothing else, which is what the four templates needed
   * and the smallest thing that makes an answer readable.
   */
  readonly globals?: Record<string, unknown>;
};

/**
 * Build a `run_code` executor that evaluates in a fresh `node:vm` context and
 * answers with whatever the code PRINTED.
 *
 * Pass it as `openEvalSession`'s / `describeEval`'s `runCode`, and the cases can
 * assert both halves — that the agent reached for code, and what the code came
 * back with.
 *
 * A throw from the evaluated code (a `SyntaxError`, a `ReferenceError`, the
 * timeout) comes back as `{ error }` rather than propagating, so the model is
 * handed its own failure and the case measures what it did next.
 *
 * ```ts no-check
 * import { createVmRunCode } from "@alexkroman1/aai-runtime/eval";
 * import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
 *
 * describeEval(agentDef, (test) => { … }, { runCode: createVmRunCode() });
 * ```
 */
export function createVmRunCode(options: VmRunCodeOptions = {}): RunCodeExecutor {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (code) => {
    const lines: string[] = [];
    const log = (...args: unknown[]): void => {
      // A string prints as itself and everything else as JSON: `String({})` is
      // `[object Object]`, which is the shape an assertion cannot read and the
      // shape a model's own `console.log(result)` produces most often.
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    try {
      runInNewContext(code, { console: { log }, ...options.globals }, { timeout });
    } catch (err) {
      return Promise.resolve({ error: errorMessage(err) });
    }
    return Promise.resolve(lines.join("\n"));
  };
}
