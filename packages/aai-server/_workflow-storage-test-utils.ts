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
            const key = `${name}.${method}`;
            calls.push({ method: key, args });
            // `in`, never `??`, so a declared answer of `undefined` means VOID.
            // With the coalescing version this fake could not express a void
            // method at all — every unspecified one answered a truthy `{ ok: true }`
            // — and `streamer.writeToStream` really does return void. That is why
            // 17 specs over this handler, including four through the guest's real
            // client, all passed while every `report()` line in production failed
            // with `answered 200 without a result`: the fake had no way to produce
            // the reply that broke it.
            return Promise.resolve(key in answers ? answers[key] : { ok: true });
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
export function claimReply(
  params: unknown[] | undefined,
  owners: Record<string, string> = OWNERS,
): Record<string, unknown>[] {
  const runId = String(params?.[0] ?? "");
  return owners[runId] === undefined ? [{ slug: String(params?.[1] ?? "") }] : [];
}

/** `ownerOf`: which agent owns the run named in the params. */
export function ownerReply(
  params: unknown[] | undefined,
  owners: Record<string, string> = OWNERS,
): Record<string, unknown>[] {
  const owner = owners[String(params?.[0] ?? "")];
  return owner === undefined ? [] : [{ slug: owner }];
}

/** `runIdsFor`: the runs of the agent named in the params. */
export function runIdsReply(
  params: unknown[] | undefined,
  owners: Record<string, string> = OWNERS,
): Record<string, unknown>[] {
  const slug = String(params?.[0] ?? "");
  return Object.entries(owners)
    .filter(([, owner]) => owner === slug)
    .map(([run_id]) => ({ run_id }));
}

/**
 * The EGRESS check's query: which of these ids does this slug own?
 *
 * Its own responder, matched before `runIdsFor`'s, because the two statements
 * share a prefix and differ only in their tail — and answering the egress check
 * with `runIdsFor`'s reply would make it pass for the wrong reason, which for a
 * check whose whole output is "nothing was foreign" is indistinguishable from
 * working.
 */
export function ownedAmongReply(
  params: unknown[] | undefined,
  owners: Record<string, string> = OWNERS,
): Record<string, unknown>[] {
  const slug = String(params?.[0] ?? "");
  const asked = Array.isArray(params?.[1]) ? params[1].map(String) : [];
  return asked.filter((runId) => owners[runId] === slug).map((run_id) => ({ run_id }));
}

/**
 * One ownership table as a `fakeAdminDbOver` responder.
 *
 * Pure dispatch over the four helpers above — every suite here needs the same
 * statements answered against some map of run id to slug, and each spec writing
 * its own inline is a duplicate that also trips Biome's cognitive-complexity cap.
 * `owners` defaults to the shared {@link OWNERS}; a spec that needs a different
 * table (an agent owning exactly one run, say) passes its own.
 *
 * ORDER MATTERS on the middle two: the egress check's statement and
 * `runIdsFor`'s share a `select run_id from …` prefix, so the more specific one
 * is matched first.
 */
export function ownershipResponder(
  owners: Record<string, string> = OWNERS,
): (sql: string, params?: unknown[]) => Record<string, unknown>[] {
  const routes: [string, (p: unknown[] | undefined) => Record<string, unknown>[]][] = [
    ["insert into aai_platform.workflow_run_owner", (p) => claimReply(p, owners)],
    ["select slug from aai_platform.workflow_run_owner", (p) => ownerReply(p, owners)],
    ["any($2::text[])", (p) => ownedAmongReply(p, owners)],
    ["select run_id from aai_platform.workflow_run_owner", (p) => runIdsReply(p, owners)],
  ];
  return (sql, params) => routes.find(([needle]) => sql.includes(needle))?.[1](params) ?? [];
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
  const adminDb = fakeAdminDbOver(ownershipResponder());
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
