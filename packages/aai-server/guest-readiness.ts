// Copyright 2026 the AAI authors. MIT license.
/**
 * "Is the guest up yet?", for both backends.
 *
 * Two shapes, because the two backends learn readiness differently. Modal
 * evaluates a readiness PROBE inside the container and the spawn awaits
 * `sandbox.waitUntilReady()` (see `GUEST_READINESS_PROBE` in
 * modal-sandbox.ts); the subprocess backend has no probes, so it polls the
 * guest's own `/health`. Both wrap the wait in {@link raceGuestExit}, which is
 * the part that must never be skipped: every way a guest fails to come up
 * exits the process with its reason on stderr, and without the race a
 * readiness wait burns its whole budget and then blames the network.
 *
 * Split from warm-harness.ts (which owns guest lifecycle wiring) because this
 * is the one concern both backends and both guest modes share.
 */

import { errorMessage } from "@alexkroman1/aai";
import { sleep } from "./_sleep.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import type { GuestFetch, GuestProcLike } from "./warm-harness.ts";

/**
 * Budget for an agent-mode guest to report READY after exec. Longer than the
 * dial budget: agent-mode boot LOADS THE BUNDLE before listening (so readiness
 * means "ready to serve sessions"), and a large worker's top-level import is
 * part of the wait.
 */
export const GUEST_READY_TIMEOUT_MS = 120_000;

/** Per-attempt cap and retry delay for the health poll. */
const AGENT_HEALTH_ATTEMPT_MS = 2000;
const AGENT_HEALTH_RETRY_MS = 250;

/**
 * Poll the guest's public `/health` until it answers 200 — agent-mode
 * readiness. The endpoint exists before the guest listens (a Modal tunnel is
 * routable immediately), so refused/reset attempts are the normal boot path.
 *
 * Races the poll against GUEST PROCESS EXIT: a boot failure (hash mismatch,
 * bundle top-level throw, bad env file) exits the guest immediately, and
 * without the race the spawn would burn the whole health deadline blaming
 * the network for what the guest's stderr already said.
 */
export async function pollGuestHealth(
  origin: string,
  proc: GuestProcLike,
  fetchFn: GuestFetch = fetch,
): Promise<void> {
  const url = guestHttpUrl(origin, GUEST_ROUTES.health);
  const deadline = Date.now() + GUEST_READY_TIMEOUT_MS;
  let lastError = "no response";
  await raceGuestExit(
    (async () => {
      for (;;) {
        try {
          const res = await fetchFn(url, { signal: AbortSignal.timeout(AGENT_HEALTH_ATTEMPT_MS) });
          if (res.ok) return;
          lastError = `HTTP ${res.status}`;
        } catch (err) {
          lastError = errorMessage(err);
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `guest /health not ready after ${GUEST_READY_TIMEOUT_MS}ms: ${lastError}`,
          );
        }
        await sleep(AGENT_HEALTH_RETRY_MS);
      }
    })(),
    proc,
  );
}

/**
 * Settle `work`, but fail immediately if the guest PROCESS exits first.
 *
 * Every way a guest can fail to come up (a bundle that throws at load, a hash
 * mismatch, a bad env file, an OOM during boot) exits the process, and the
 * reason is on its stderr. Without this race, a readiness wait burns its whole
 * budget and then blames the network for what the guest already explained —
 * which is why the error points at the host log, where `startGuestLogging` has
 * been relaying stderr since before the wait began.
 *
 * The exit watcher is attached BEFORE awaiting, so an exit that happens
 * during `work` is observed rather than missed.
 */
export async function raceGuestExit<T>(work: Promise<T>, proc: GuestProcLike): Promise<T> {
  // Contained: on the exit path nothing awaits `work`, and a rejection
  // afterwards must not surface as unhandled.
  work.catch(() => undefined);
  const exited = proc.wait().then(
    (code) => code,
    () => -1,
  );
  const outcome = await Promise.race([
    work.then((value) => ({ value }) as { value: T }),
    exited.then((code) => ({ exit: code })),
  ]);
  if ("exit" in outcome) {
    throw new Error(
      `guest exited before ready (exit ${outcome.exit}) — see its stderr in the host log`,
    );
  }
  return outcome.value;
}
