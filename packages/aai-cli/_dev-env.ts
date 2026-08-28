// Copyright 2026 the AAI authors. MIT license.
/**
 * The dev server's CONTROL variables — the three things read straight from the
 * shell rather than from the agent's `.env`.
 *
 * That distinction is the reason these live together. `resolveServerEnv` builds
 * `ctx.env` from `.env`-declared keys only, deliberately, so an agent cannot
 * come to depend on a shell variable that will not exist after deploy. These
 * three are not agent config at all — they configure the *dev server process*
 * (who may connect, where it binds, whether it restarts), so they are read from
 * the environment on purpose and must never leak into `ctx.env`.
 *
 * `createDevLogger` sits here for the second half of that reason rather than
 * the first: it is not a control variable, it READS one — the same auto-
 * detected JSON mode — to decide where the runtime's diagnostics go. Both
 * were split out of `_dev-server.ts` to keep it under the file-length cap,
 * and `_dev-server.ts` is the only consumer of either.
 */

import type { Logger } from "@alexkroman1/aai-runtime";
import { consoleLogger } from "@alexkroman1/aai-runtime/internal";

/**
 * The env handed to `createServer` for host-mode connections: provider
 * credentials plus the `AAI_ALLOW_HOST` gate read straight from the shell
 * (it is a control variable, not something an agent declares in `.env`).
 */
export function hostModeEnv(providerEnv: Record<string, string>): Record<string, string> {
  const gate = process.env.AAI_ALLOW_HOST;
  return gate === undefined ? providerEnv : { ...providerEnv, AAI_ALLOW_HOST: gate };
}

/**
 * Explicit bind host for the dev server, or `undefined` to take the
 * loopback default. An empty `AAI_DEV_HOST` means "unset", not "every
 * interface" — Node treats `listen(port, "")` as 0.0.0.0, which would quietly
 * undo the loopback default this exists to guard.
 */
export function devBindHost(): string | undefined {
  const host = process.env.AAI_DEV_HOST?.trim();
  return host ? host : undefined;
}

/**
 * File watching is OPT-IN — `aai dev --watch`, or `AAI_DEV_WATCH=1`.
 *
 * A restart rebuilds the bundle and replaces the server, which drops nothing
 * mid-request but does end in-flight voice sessions. That is the right default
 * while editing an agent and the wrong one while a benchmark is driving the
 * host for twenty minutes: a stray formatter save, a `.env` touch, or a git
 * operation restarts the server underneath the run, and the harness reports it
 * as a provider failure several records deep.
 *
 * **The FLAG exists because the variable was undiscoverable**, which made the
 * default a defect rather than a decision: `aai dev --help` listed nothing about
 * watching, `AAI_DEV_WATCH` appeared in no document a user reads, and the guide
 * shipped into every scaffolded project opened with "Iterate in `pnpm dev` —
 * hot reload". So the promise was false and there was no way to find the switch
 * that makes it true. The variable stays for a process supervisor, which has an
 * environment and no argv.
 *
 * The flag WINS when passed, in both directions: `--watch` turns it on where the
 * variable is unset or off, and `--watch=false` turns it off where the variable
 * says on — an explicit argument that a stale exported variable could override
 * would be the same discoverability bug wearing the fix's clothes.
 */
export function devWatchEnabled(flag?: boolean | undefined): boolean {
  if (flag !== undefined) return flag;
  return /^(1|true|yes|on)$/i.test(process.env.AAI_DEV_WATCH?.trim() ?? "");
}

/**
 * The logger the dev server's runtime writes through.
 *
 * The SDK's default logger is console-backed and `console.log` is STDOUT, so
 * in JSON mode the runtime's own diagnostics — the multi-line "Session mode
 * resolved" dump at startup, every later warning — landed on stdout ahead of
 * the single result line `aai dev` promises there. JSON mode is AUTO-DETECTED
 * on a pipe, so that is the normal case rather than an opt-in one:
 * `aai dev > dev.log`, a process supervisor, a container. It is the same
 * hazard `notify` exists for, one layer down: `silenceOutput()` only reaches
 * this CLI's own `log`, and the runtime is not using it.
 *
 * Human mode keeps the console logger exactly as it was — a TTY has nothing
 * to parse, and stdout is where people are already reading these.
 */
export function createDevLogger(silenced: boolean): Logger {
  if (!silenced) return consoleLogger;
  const write = (msg: string, ctx?: Record<string, unknown>): void => {
    // Carries the runtime's structured context too, rather than dropping it
    // the way a plain `notify` line would.
    process.stderr.write(`${msg}${ctx === undefined ? "" : ` ${JSON.stringify(ctx)}`}\n`);
  };
  return { info: write, warn: write, error: write, debug: () => undefined };
}
