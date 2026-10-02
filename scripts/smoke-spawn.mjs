#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.

/**
 * Spawn one real sandbox against the platform that was just deployed, then
 * delete it.
 *
 * ## Why this exists
 *
 * Every other gate on the deploy path PREDICTS that a sandbox could spawn.
 * `wait-for-npm-versions.mjs` predicted it by asking npm whether the SDK was
 * readable; `wait-for-guest-image.mjs` predicted it by asking GHCR whether the
 * image tag existed; `verify_modal_deploy.py` predicts that the app is serving.
 * None of them spawns anything, and the failure this pipeline keeps having is a
 * spawn failure — the image is pulled at SPAWN time, not at deploy time, so a
 * deploy can be green for hours while every agent session and studio session
 * 404s on the pull.
 *
 * The predictions also cannot cover the last hop, and this is the real argument
 * for observing instead. `GUEST_IMAGE_REGISTRY` decides which registry a spawn
 * pulls from, and production reads it from the Modal secret `aai-server` — a
 * value CI cannot see. So a check that asks "did we publish the image?" is
 * asking a different environment than the one that answers at spawn time, and a
 * changed secret leaves every gate green while nothing can start. Only a spawn
 * asks the question of the environment that answers it.
 *
 * ## What it proves, and what it does not
 *
 * The deployed platform can resolve its guest image, start a sandbox from it,
 * boot the harness inside, and broker a session URL. That is the whole failure
 * class above.
 *
 * The worker it deploys is a REAL one: `aai build` of the quickstart template,
 * built by the `guest-image` job from the same tree and handed over as an
 * artifact. It cannot be a hand-written stub any more — the harness drives an
 * agent entirely through the runtime the bundle ships
 * (`__aaiCreateRuntime.host`: the HTTP server, the session gate, the workflow
 * door) and refuses a bundle without it, so a stub would have to re-implement
 * that internal contract and would drift from it silently. One did: it failed
 * every spawn from the release that started requiring the surface.
 *
 * No provider is contacted: `EnvSchema` does not validate the key, and nothing
 * here starts a voice session, so the placeholder below costs nothing.
 *
 * ## It cleans up after itself, and says so when it cannot
 *
 * The agent is deleted in a `finally`. A leaked one is not free — it is a row,
 * a bundle and a slug in production — so a failed delete is reported LOUDLY
 * with the slug to remove by hand, rather than swallowed. It does not fail the
 * run on its own: the spawn is the verdict, and turning a successful rollout
 * red over a leaked test agent would train people to ignore this step.
 *
 * CLI, and the deploy job's only caller:
 *   AAI_PLATFORM_URL=… AAI_API_KEY=… node scripts/smoke-spawn.mjs
 *     --worker <path/to/worker.mjs> [--timeout-seconds N] [--interval-seconds N]
 *
 * Its spec is `packages/aai-gates/src/smoke-spawn-gate.test.ts`. Every exported
 * function here exists to be driven from there: nothing above the CLI guard at
 * the bottom touches the network, the clock or `process.exit` on import.
 *
 * @module smoke-spawn
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
// `scheduler.wait`, matching the polling scripts this replaced.
import { scheduler } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseScriptArgs } from "./_args.mjs";

/**
 * How long a cold spawn is given.
 *
 * The first spawn after a deploy pulls the whole guest image onto a fresh
 * worker, which is the slowest this ever is. Generous on purpose: the cost of
 * waiting too long is one idle runner, and the cost of waiting too little is a
 * red deploy over a healthy platform — the exact failure the waiter deadlines
 * this replaced kept producing.
 */
const DEFAULT_TIMEOUT_SECONDS = 8 * 60;

/** Gap between broker attempts. */
const DEFAULT_INTERVAL_SECONDS = 10;

/** Per-request cap, so one hung fetch cannot consume the whole budget. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * A slug that cannot collide with a real agent or with a previous run's leak.
 *
 * `VALID_SLUG_RE` wants `[a-z0-9][a-z0-9_-]*[a-z0-9]`, and the `-preview`
 * suffix is owned by the studio's auto-preview deploys and reaped by the orphan
 * sweep — hex has neither problem.
 *
 * @param {() => string} random - injectable for the spec
 */
export function smokeSlug(random = () => randomBytes(5).toString("hex")) {
  return `ci-smoke-${random()}`;
}

/**
 * The deploy body for one smoke agent.
 *
 * @param {string} slug
 * @param {string} worker - the built worker bundle's source
 */
export function smokeDeployBody(slug, worker) {
  return {
    slug,
    // Present because a deployed agent declares its provider key, and unused
    // because nothing here opens a session. Not a real credential.
    env: { ASSEMBLYAI_API_KEY: "ci-smoke-not-a-real-key" },
    worker,
    clientFiles: { "index.html": "<!doctype html><title>ci smoke</title>" },
  };
}

/**
 * One `fetch` with a bounded deadline, returning the status and body text
 * rather than throwing — every caller here wants to REPORT what happened, and
 * an exception loses the status.
 *
 * @param {{ url: string, init?: RequestInit, fetchImpl?: typeof fetch, timeoutMs?: number }} args
 * @returns {Promise<{ ok: boolean, status: number, body: string, error?: string }>}
 */
export async function request({
  url,
  init = {},
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, body: "", error: err instanceof Error ? err.message : `${err}` };
  }
}

/**
 * Poll `/:slug/client-config` until it brokers a session URL, or the deadline
 * passes.
 *
 * That route is the spawn: resolving the sandbox is what boots it on the first
 * request (see `client-config-handler.ts`), and it needs no auth. The assertion
 * is on `sessionUrl` and NOT on the name/greeting beside it, deliberately —
 * those are proxied from the guest's own config and the handler degrades to
 * `{ sessionUrl }` when the guest cannot answer, so requiring them would fail
 * on a difference that is not about the image at all.
 *
 * @param {{
 *   base: string, slug: string, fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<unknown>, now?: () => number,
 *   timeoutMs?: number, intervalMs?: number, log?: (line: string) => void,
 * }} args
 * @returns {Promise<{ ok: boolean, attempts: number, detail: string }>}
 */
export async function brokerSandbox({
  base,
  slug,
  fetchImpl = fetch,
  sleep = (ms) => scheduler.wait(ms),
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  intervalMs = DEFAULT_INTERVAL_SECONDS * 1000,
  log = console.log,
}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let detail = "not attempted";
  for (;;) {
    attempts += 1;
    const res = await request({ url: `${base}/${slug}/client-config`, fetchImpl });
    if (res.ok) {
      let sessionUrl;
      try {
        sessionUrl = JSON.parse(res.body)?.sessionUrl;
      } catch {
        // Falls through to the not-JSON detail below.
      }
      if (typeof sessionUrl === "string" && sessionUrl.length > 0) {
        return { ok: true, attempts, detail: sessionUrl };
      }
      detail = `200 with no sessionUrl: ${res.body.slice(0, 200)}`;
    } else {
      detail = res.error ?? `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
    }
    const elapsedSeconds = Math.round((now() - startedAt) / 1000);
    log(`  spawning  ${slug} — ${detail} (${elapsedSeconds}s elapsed)`);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { ok: false, attempts, detail };
    await sleep(Math.min(intervalMs, remainingMs));
  }
}

/**
 * @param {string | undefined} raw
 * @param {string} flag
 * @param {number} fallback
 * @returns {number}
 */
function seconds(raw, flag, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} expects a positive number of seconds, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * The two settings, read from the environment and REQUIRED.
 *
 * Missing is a hard failure rather than a skip, on the rule this repository
 * keeps relearning: a gate that no-ops when it is not configured is
 * indistinguishable from a gate that passed, and every incident in this
 * pipeline's history has that shape. The error names the secret so the remedy
 * is one line rather than a reading of this file.
 *
 * @param {Record<string, string | undefined>} env
 */
export function readSettings(env) {
  const base = env.AAI_PLATFORM_URL?.trim().replace(/\/+$/, "");
  const key = env.AAI_API_KEY?.trim();
  // The guard tests the VALUES rather than a count, so that the return below
  // hands back two strings: a `missing.length > 0` test throws on exactly the
  // same inputs but narrows neither, and both are read as strings downstream.
  if (!(base && key)) {
    const missing = [];
    if (!base) missing.push("AAI_PLATFORM_URL");
    if (!key) missing.push("AAI_API_KEY");
    throw new Error(
      `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. ` +
        "AAI_PLATFORM_URL is the deployed app URL (the Deploy step prints it); " +
        "AAI_API_KEY comes from the AAI_SMOKE_API_KEY secret on the production " +
        "environment — a platform API key whose only job is this check. Without " +
        "them the deploy would ship unverified: nothing else in this workflow " +
        "spawns a sandbox.",
    );
  }
  return { base, key };
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, env = process.env) {
  const { values: flags } = parseScriptArgs({
    script: import.meta.url,
    options: {
      "timeout-seconds": { type: "string" },
      "interval-seconds": { type: "string" },
      worker: { type: "string" },
    },
    argv,
  });
  const { base, key } = readSettings(env);
  // Required, for the same reason the two settings are: without it there is
  // nothing to spawn, and a skip would read as a pass.
  if (!flags.worker) {
    throw new Error(
      "--worker is required: the path to a built worker bundle (`aai build`'s " +
        "`.aai/worker.mjs`). The ship workflow's `guest-image` job builds it and " +
        "uploads it as the `smoke-worker` artifact.",
    );
  }
  const worker = await readFile(flags.worker, "utf-8");
  const timeoutSeconds = seconds(
    flags["timeout-seconds"],
    "--timeout-seconds",
    DEFAULT_TIMEOUT_SECONDS,
  );
  const intervalSeconds = seconds(
    flags["interval-seconds"],
    "--interval-seconds",
    DEFAULT_INTERVAL_SECONDS,
  );
  const slug = smokeSlug();
  const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  console.log(`Smoke-spawning ${slug} on ${base}`);
  const deployed = await request({
    url: `${base}/deploy`,
    init: { method: "POST", headers: auth, body: JSON.stringify(smokeDeployBody(slug, worker)) },
  });
  if (!deployed.ok) {
    console.error(
      `::error title=Smoke deploy failed::POST /deploy for ${slug} answered ` +
        `${deployed.error ?? `HTTP ${deployed.status}: ${deployed.body.slice(0, 400)}`} — the ` +
        "platform is serving but cannot accept a deploy.",
    );
    return 1;
  }

  try {
    const spawned = await brokerSandbox({
      base,
      slug,
      timeoutMs: timeoutSeconds * 1000,
      intervalMs: intervalSeconds * 1000,
    });
    if (!spawned.ok) {
      console.error(
        `::error title=Smoke spawn failed::${slug} never brokered a session in ` +
          `${timeoutSeconds}s (${spawned.attempts} attempts, last: ${spawned.detail}). The ` +
          "rollout is serving but cannot start a sandbox — check that the guest image this " +
          "commit's tag names was published, and that GUEST_IMAGE_REGISTRY in the Modal " +
          "secret `aai-server` names the registry it was published to. Modal reports a " +
          "missing manifest as `Image build for im-<id> failed with the exception:` and then " +
          "nothing, so the app log will not name the tag.",
      );
      return 1;
    }
    console.log(`sandbox spawned and brokered ${spawned.detail} ✓`);
    return 0;
  } finally {
    // No trailing slash: Hono's `mergePath` collapses the agents router's
    // `DELETE /` to `/:slug`, so `/:slug/` matches nothing and 404s — which is
    // how every smoke agent leaked. The same path `aai delete` uses.
    const deleted = await request({
      url: `${base}/${slug}`,
      init: { method: "DELETE", headers: auth },
    });
    if (deleted.ok) console.log(`cleaned up ${slug}`);
    else {
      console.error(
        `::warning title=Smoke agent leaked::could not delete ${slug} ` +
          `(${deleted.error ?? `HTTP ${deleted.status}`}) — remove it by hand.`,
      );
    }
  }
}

// CLI entry.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::smoke-spawn: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
