// Copyright 2026 the AAI authors. MIT license.
/**
 * The fixtures both halves of the run-storage route's specs run against.
 *
 * Shared because they model one thing — a platform whose ownership table is a
 * fixture and whose world is a recorder — and the two suites that need it are
 * split by SUBJECT (the DevKit's Storage in one file, its Streamer in the other)
 * rather than by setup. Copying them would let the two drift on the detail that
 * matters most: which agent owns which run.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { guestTokenFor } from "./guest-token.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { createTestOrchestrator, fakeAdminDbOver, type TestFetch } from "./test-utils.ts";
import type { PlatformWorldStorage } from "./workflow-storage-world.ts";

export const MINE = "mine-agent";
export const THEIRS = "theirs-agent";

/** Ownership as this suite's fixture: run id → slug. */
export const OWNERS: Record<string, string> = { run_mine: MINE, run_theirs: THEIRS };

/**
 * A recording stand-in for the DevKit's world.
 *
 * Every member records its arguments and answers whatever the test wants — which
 * is the point: a real world could never be made to return another tenant's hook.
 */
export function fakeWorld(
  answers: Record<string, unknown> = {},
  /**
   * Methods this world does NOT expose, for the spec about their shape moving.
   *
   * A parameter rather than deleting a member afterwards: the members are typed
   * `unknown` on `PlatformWorldStorage` (see that module for why), so reassigning
   * one needs a cast through `unknown` — a counted escape hatch, and one that would
   * stop reporting the moment their shape really does move.
   */
  absent: readonly string[] = [],
): PlatformWorldStorage & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const group = (name: string, methods: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(
      methods
        .filter((method) => !absent.includes(`${name}.${method}`))
        .map((method) => [
          method,
          (...args: unknown[]) => {
            calls.push({ method: `${name}.${method}`, args });
            return Promise.resolve(answers[`${name}.${method}`] ?? { ok: true });
          },
        ]),
    );
  return {
    calls,
    runs: group("runs", ["get", "list"]),
    steps: group("steps", ["get", "list"]),
    events: group("events", ["create", "get", "list", "listByCorrelationId"]),
    hooks: group("hooks", ["get", "getByToken", "list"]),
    streamer: group("streamer", [
      "writeToStream",
      "writeToStreamMulti",
      "closeStream",
      "listStreamsByRunId",
      "getStreamChunks",
      "getStreamInfo",
    ]),
    close: () => Promise.resolve(),
  };
}

/** `claimRun`'s insert: nothing inserted means the id is already owned. */
export function claimReply(params: unknown[] | undefined): Record<string, unknown>[] {
  const runId = String(params?.[0] ?? "");
  return OWNERS[runId] === undefined ? [{ slug: String(params?.[1] ?? "") }] : [];
}

/** `ownerOf`: which agent owns the run named in the params. */
export function ownerReply(params: unknown[] | undefined): Record<string, unknown>[] {
  const owner = OWNERS[String(params?.[0] ?? "")];
  return owner === undefined ? [] : [{ slug: owner }];
}

/** `runIdsFor`: the runs of the agent named in the params. */
export function runIdsReply(params: unknown[] | undefined): Record<string, unknown>[] {
  const slug = String(params?.[0] ?? "");
  return Object.entries(OWNERS)
    .filter(([, owner]) => owner === slug)
    .map(([run_id]) => ({ run_id }));
}

/**
 * A platform whose ownership table is this suite's fixture.
 *
 * The responder reads the RUN ID out of the PARAMS, which is the whole reason it
 * can express the case these specs are about: one request may check several runs
 * (a correlation-id list does), and a fake keyed on the statement alone answers the
 * same way for all of them — which is how three cross-tenant specs came to pass
 * against a fixture that could not tell the two runs apart, and would have passed
 * against no filter at all.
 */
export async function platform(world = fakeWorld()) {
  const adminDb = fakeAdminDbOver((sql, params) => {
    if (sql.includes("insert into aai_platform.workflow_run_owner")) return claimReply(params);
    if (sql.includes("select slug from aai_platform.workflow_run_owner")) return ownerReply(params);
    if (sql.includes("select run_id from aai_platform.workflow_run_owner")) {
      return runIdsReply(params);
    }
    return [];
  });
  const harness = await createTestOrchestrator({ adminDb, runStorage: world });
  await deploy(harness.fetch, MINE);
  await deploy(harness.fetch, THEIRS);
  return { ...harness, world };
}

export async function deploy(fetch: TestFetch, slug: string): Promise<void> {
  const res = await fetch("/deploy", {
    method: "POST",
    headers: { Authorization: "Bearer key1", "Content-Type": "application/json" },
    body: JSON.stringify({
      slug,
      env: { ASSEMBLYAI_API_KEY: "k" },
      worker:
        'export default { name: "a", systemPrompt: "p", greeting: "", maxSteps: 1, tools: {} };',
      clientFiles: {},
    }),
  });
  if (!res.ok) throw new Error(`deploy ${slug} answered ${res.status}: ${await res.text()}`);
}

export async function bearerFor(
  store: { getAgentVersion(slug: string): Promise<number | null> },
  slug: string,
): Promise<string> {
  const version = (await store.getAgentVersion(slug)) ?? 1;
  return guestTokenFor(agentSandboxName(slug, version));
}

export function callStorage(
  fetch: TestFetch,
  slug: string,
  body: unknown,
  bearer?: string,
): Promise<Response> {
  const authorization = bearer === undefined ? undefined : `Bearer ${bearer}`;
  return fetch(`/${slug}/workflow-storage`, {
    method: "POST",
    headers: { "content-type": "application/json", ...omitUndefined({ authorization }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
