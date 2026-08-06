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
 * Split out of `_dev-server.ts` purely to keep that module under the
 * file-length cap; it is the only consumer.
 */

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
 * File watching is OPT-IN — `AAI_DEV_WATCH=1` turns it on.
 *
 * A restart rebuilds the bundle and replaces the server, which drops nothing
 * mid-request but does end in-flight voice sessions. That is the right default
 * while editing an agent and the wrong one while a benchmark is driving the
 * host for twenty minutes: a stray formatter save, a `.env` touch, or a git
 * operation restarts the server underneath the run, and the harness reports it
 * as a provider failure several records deep.
 */
export function devWatchEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.AAI_DEV_WATCH?.trim() ?? "");
}
