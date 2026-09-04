/**
 * Run a command as a child and mirror its outcome — the half of a wrapper
 * script that is subtle, in one place.
 *
 * Both wrappers here (`dev-server.mjs`, `with-test-pg.mjs`) exist to resolve
 * some environment and then hand off, and a naive hand-off gets Ctrl-C wrong in
 * two ways that compound. Measured on `pnpm dev:aai-server`:
 *
 * - **A wrapper with no signal handler DIES FIRST.** Ctrl-C goes to the whole
 *   foreground process GROUP, so the wrapper and the child both get SIGINT; with
 *   no listener installed, Node applies the default action and the wrapper is
 *   gone immediately — while the child is still draining. pnpm sees ITS child
 *   (the wrapper) terminated by a signal and reports
 *   `ELIFECYCLE Command failed with signal "SIGINT"`, and the server's own
 *   shutdown lines then print AFTER that error, which is how you can tell this
 *   is the bug rather than a failing server. Installing a listener is what keeps
 *   the wrapper alive; the child's handle keeps the event loop alive with it.
 * - **A signal-terminated child became exit 1.** `signal ? 1 : code` turns a
 *   stop the user ASKED for into a failure, so a clean Ctrl-C ends in an error
 *   report. What that should be is the caller's decision, hence
 *   {@link RunChildOptions.interruptExitCode} — a dev server stopped on purpose
 *   is a success, an interrupted test run genuinely did not verify anything.
 *
 * The signal is FORWARDED rather than left to the group, and the double delivery
 * that implies is safe by construction: `createShutdownHandler`
 * (`aai-server/serve-lifecycle.ts`) latches on a `running` flag precisely so a
 * second SIGTERM cannot run teardown twice. Forwarding is what covers the case
 * the group does not — `kill -TERM <wrapper pid>`, where the child would
 * otherwise never hear about it and outlive its parent.
 */

import { spawn } from "node:child_process";

/** Signals a wrapper forwards and treats as a requested stop. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM"];

/**
 * Spawn `command`, forward stop signals to it, and exit the way it did.
 *
 * @param {string[]} command argv, already split
 * @param {{ env?: Record<string, string>, label: string, interruptExitCode: number }} options
 *   `label` prefixes a spawn failure; `interruptExitCode` is what a SIGINT/SIGTERM
 *   stop exits with (0 for "the user asked", non-zero for "this did not finish").
 */
export function runChild(command, options) {
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ...options.env },
    shell: process.platform === "win32",
  });

  for (const signal of /** @type {readonly NodeJS.Signals[]} */ (STOP_SIGNALS)) {
    process.on(signal, () => {
      // Nothing else: no exit, no timer. The child owns the shutdown, and this
      // handler's real job is to REPLACE Node's default action so the wrapper
      // outlives it. `kill` on an already-dead child throws ESRCH, which is a
      // race with its exit and not worth reporting.
      try {
        child.kill(signal);
      } catch {
        // Already gone — its `exit` below is what settles this run.
      }
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) process.exit(STOP_SIGNALS.includes(signal) ? options.interruptExitCode : 1);
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    console.error(`${options.label}: could not run \`${command.join(" ")}\`: ${err.message}`);
    process.exit(1);
  });
  return child;
}
