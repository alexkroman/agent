// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow wake sweep: turning "a run is due" into "that agent is running".
 *
 * The property under test is narrow and the reasoning around it is not, so read
 * `workflow-wake.ts`'s module doc first. What these specs pin is the part that is
 * silent when wrong: an app is a candidate only if its schema really carries a
 * journal, the slug↔schema mapping survives a one-way hash, one unreachable
 * cluster does not strand the runs on the others, and a fleet larger than one tick
 * is deferred rather than dropped.
 */

import { describe, expect, test, vi } from "vitest";
import { type AgentRows, createMemoryAgentRows } from "./agent-store.ts";
import { type AppDbTarget, appDbIdentifier } from "./app-database.ts";
import { MAX_WAKE_CANDIDATE_SLUGS, MAX_WAKE_PER_TICK, WORKFLOW_BLOB_TTL_MS } from "./constants.ts";
import {
  startWorkflowWake,
  sweepWorkflowWakes,
  wakeInternalToken,
  wakeReachedGuest,
} from "./workflow-wake.ts";

const silent = { info: vi.fn(), error: vi.fn() };

/** Agent rows carrying `slugs`, as deploys would have left them. */
async function agentsWith(slugs: string[]): Promise<AgentRows> {
  const rows = createMemoryAgentRows();
  for (const slug of slugs) {
    await rows.put({
      slug,
      credential_hashes: [],
      worker_hash: "h",
      client_files: {},
      harness_image_tag: null,
    });
  }
  return rows;
}

/**
 * A cluster that reports `withJournal` as having the journal tables and
 * `withWork` as having something due.
 *
 * The two queries are told apart by shape rather than by call order, because the
 * order is an implementation detail the sweep is free to change.
 *
 * The catalog answer is PER TABLE, matching the real query — a schema can carry
 * `aai_workflow_runs` and not `aai_workflow_blobs` (a journal predating migration
 * `0007-blobs`, or an `init()` that applied partway), and naming a table a schema
 * lacks aborts the whole union rather than its own branch. `opts.withoutBlobs`
 * is how a spec builds that schema.
 */
function fakeCluster(
  withJournal: string[],
  withWork: string[],
  opts: { withoutBlobs?: string[] } = {},
): AppDbTarget & { calls: string[] } {
  const calls: string[] = [];
  const withoutBlobs = new Set(opts.withoutBlobs ?? []);
  const sql = vi.fn((query: string, params?: unknown[]) => {
    calls.push(query);
    if (query.includes("pg_namespace")) {
      const asked = (params?.[1] ?? []) as string[];
      const rows: { schema: string; table_name: string }[] = [];
      for (const schema of withJournal) {
        if (!asked.includes(schema)) continue;
        rows.push({ schema, table_name: "aai_workflow_runs" });
        if (!withoutBlobs.has(schema)) {
          rows.push({ schema, table_name: "aai_workflow_blobs" });
        }
      }
      return Promise.resolve(rows);
    }
    // The union query: answer with whichever of its branches has work.
    return Promise.resolve(withWork.filter((s) => query.includes(s)).map((schema) => ({ schema })));
  });
  return { url: "postgres://cluster", sql, calls };
}

describe("sweepWorkflowWakes", () => {
  test("wakes exactly the agents whose journal has a due run", async () => {
    const agents = await agentsWith(["busy", "quiet"]);
    const cluster = fakeCluster(
      [appDbIdentifier("busy"), appDbIdentifier("quiet")],
      [appDbIdentifier("busy")],
    );
    const wake = vi.fn(() => Promise.resolve());

    const result = await sweepWorkflowWakes({
      agents,
      targets: [cluster],
      wake,
      logger: silent,
    });

    // The slug, not the schema — `appDbIdentifier` is one-way, so the map built on
    // the way out is the only route back and a bug there is a silent no-op.
    expect(result.woken).toEqual(["busy"]);
    expect(wake).toHaveBeenCalledExactlyOnceWith("busy");
  });

  test("costs nothing for an app with no journal at all", async () => {
    // Most agents are voice agents with no storage. The catalog query is what
    // keeps them out, so the union query must not even name them — a branch
    // against a missing table aborts the whole statement, not just its own.
    const agents = await agentsWith(["voice-only"]);
    const cluster = fakeCluster([], []);
    const wake = vi.fn(() => Promise.resolve());

    const result = await sweepWorkflowWakes({ agents, targets: [cluster], wake, logger: silent });

    expect(result.woken).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    // One catalog query and no union query.
    expect(cluster.calls).toHaveLength(1);
    expect(cluster.calls[0]).toContain("pg_namespace");
  });

  test("asks each cluster only about the schemas it could hold", async () => {
    const agents = await agentsWith(["a", "b"]);
    const cluster = fakeCluster([appDbIdentifier("a")], [appDbIdentifier("a")]);

    await sweepWorkflowWakes({
      agents,
      targets: [cluster],
      wake: () => Promise.resolve(),
      logger: silent,
    });

    // The union query names the ONE schema the catalog confirmed, not both.
    const union = cluster.calls.find((q) => q.includes("union all") || q.includes("exists"));
    expect(union).toContain(appDbIdentifier("a"));
    expect(union).not.toContain(appDbIdentifier("b"));
  });

  test("counts an expired blob as work, so pruning is not boot-only", async () => {
    // `runDue()` prunes abandoned uploads and only runs at boot, so an app that
    // never boots again leaks them forever. One predicate, two reasons.
    const agents = await agentsWith(["leaky"]);
    const cluster = fakeCluster([appDbIdentifier("leaky")], [appDbIdentifier("leaky")]);

    await sweepWorkflowWakes({
      agents,
      targets: [cluster],
      wake: () => Promise.resolve(),
      logger: silent,
    });

    const union = cluster.calls.find((q) => q.includes("aai_workflow_blobs"));
    expect(union).toContain("aai_workflow_blobs");
    expect(union).toContain("created_at <");
  });

  test("one unreachable cluster does not strand the runs on the others", async () => {
    const agents = await agentsWith(["here", "there"]);
    const broken: AppDbTarget = {
      url: "postgres://down",
      sql: () => Promise.reject(new Error("connection refused")),
    };
    const healthy = fakeCluster([appDbIdentifier("there")], [appDbIdentifier("there")]);
    const logger = { info: vi.fn(), error: vi.fn() };

    const result = await sweepWorkflowWakes({
      agents,
      targets: [broken, healthy],
      wake: () => Promise.resolve(),
      logger,
    });

    expect(result.woken).toEqual(["there"]);
    // Reported rather than swallowed: a cluster that is always down is a real
    // outage, and the sweep is the only thing that would notice.
    expect(logger.error).toHaveBeenCalled();
  });

  test("a slug that cannot be woken is left for the next tick", async () => {
    const agents = await agentsWith(["gone", "fine"]);
    const cluster = fakeCluster(
      [appDbIdentifier("gone"), appDbIdentifier("fine")],
      [appDbIdentifier("gone"), appDbIdentifier("fine")],
    );
    const logger = { info: vi.fn(), error: vi.fn() };
    const wake = vi.fn((slug: string) =>
      slug === "gone" ? Promise.reject(new Error("no such agent")) : Promise.resolve(),
    );

    const result = await sweepWorkflowWakes({ agents, targets: [cluster], wake, logger });

    // The failure does not abort the tick — the run is durable, so lateness is
    // the only cost of trying again.
    expect(result.woken).toEqual(["fine"]);
    expect(logger.error).toHaveBeenCalled();
  });

  test("defers a fleet larger than one tick rather than booting all of it", async () => {
    const slugs = Array.from({ length: MAX_WAKE_PER_TICK + 3 }, (_unused, i) => `app-${i}`);
    const agents = await agentsWith(slugs);
    const schemas = slugs.map(appDbIdentifier);
    const cluster = fakeCluster(schemas, schemas);
    const wake = vi.fn(() => Promise.resolve());

    const result = await sweepWorkflowWakes({ agents, targets: [cluster], wake, logger: silent });

    // Booting sandboxes is the sweep's one expensive act, and a redeploy that
    // abandons runs across many agents would otherwise ask for all of them at once.
    expect(result.woken).toHaveLength(MAX_WAKE_PER_TICK);
    expect(result.deferred).toBe(3);
    expect(wake).toHaveBeenCalledTimes(MAX_WAKE_PER_TICK);
  });

  test("does nothing, and touches no cluster, with no agents deployed", async () => {
    const cluster = fakeCluster([], []);
    const result = await sweepWorkflowWakes({
      agents: createMemoryAgentRows(),
      targets: [cluster],
      wake: () => Promise.resolve(),
      logger: silent,
    });

    expect(result).toEqual({ woken: [], deferred: 0, nextCursor: undefined });
    expect(cluster.calls).toEqual([]);
  });

  test("a schema missing the blobs table is still probed for due runs", async () => {
    // The catalog pre-check asked only about `aai_workflow_runs` while every
    // branch also named `aai_workflow_blobs`, so ONE schema without the blobs
    // table (a journal predating migration `0007-blobs`) made the union a parse
    // error — and the cluster-level `catch` swallowed it, so no agent on that
    // whole cluster was ever woken again, the failing app included.
    const agents = await agentsWith(["old", "new"]);
    const oldSchema = appDbIdentifier("old");
    const cluster = fakeCluster([oldSchema, appDbIdentifier("new")], [oldSchema], {
      withoutBlobs: [oldSchema],
    });
    const logger = { info: vi.fn(), error: vi.fn() };

    const result = await sweepWorkflowWakes({
      agents,
      targets: [cluster],
      wake: () => Promise.resolve(),
      logger,
    });

    expect(result.woken).toEqual(["old"]);
    // Its branch probes runs and NOT blobs, which is what keeps the statement
    // parseable; the other schema's branch still probes both.
    const union = cluster.calls.find((q) => q.includes("union all")) ?? "";
    const oldBranch = union.split("union all").find((b) => b.includes(oldSchema)) ?? "";
    expect(oldBranch).toContain("aai_workflow_runs");
    expect(oldBranch).not.toContain("aai_workflow_blobs");
    expect(logger.error).not.toHaveBeenCalled();
  });

  test("advances its candidate window across ticks, so a fleet past the cap is reachable", async () => {
    // With no cursor every tick re-read the SAME first page, so an agent sorting
    // past `MAX_WAKE_CANDIDATE_SLUGS` was never a candidate and its runs never
    // resumed — which the cap's own doc claimed was merely lateness.
    // A real over-cap fleet rather than a shrunken cap: the wrap condition is
    // `page.length < MAX_WAKE_CANDIDATE_SLUGS`, so a faked page size cannot
    // exercise it.
    const slugs = Array.from(
      { length: MAX_WAKE_CANDIDATE_SLUGS + 2 },
      // Padded so lexical order (what both stores sort by) matches numeric order.
      (_unused, i) => `app-${String(i).padStart(4, "0")}`,
    );
    const agents = await agentsWith(slugs);
    // Nothing to wake: the candidate WINDOW is the subject, not the brokering.
    const cluster = fakeCluster([], []);
    const asked: (string | undefined)[] = [];
    const rows: AgentRows = {
      ...agents,
      listSlugs(limit, after) {
        asked.push(after);
        return agents.listSlugs(limit, after);
      },
    };
    const opts = {
      agents: rows,
      targets: [cluster],
      wake: () => Promise.resolve(),
      logger: silent,
    };

    const first = await sweepWorkflowWakes(opts);
    // A full page, so the next tick resumes after its last slug.
    const lastOfFirstPage = slugs[MAX_WAKE_CANDIDATE_SLUGS - 1];
    expect(first.nextCursor).toBe(lastOfFirstPage);

    const second = await sweepWorkflowWakes(opts, WORKFLOW_BLOB_TTL_MS, first.nextCursor);
    // Two slugs left — a short page — so the tick after that starts over rather
    // than sitting past the end of the fleet forever.
    expect(second.nextCursor).toBeUndefined();
    expect(asked).toEqual([undefined, lastOfFirstPage]);
  });

  test("the blob cutoff it sends matches the SDK's own TTL", () => {
    // The platform keeps its own copy of this number rather than importing the
    // SDK's host module for it, so the two have to be pinned as agreeing.
    expect(WORKFLOW_BLOB_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("startWorkflowWake", () => {
  test("is inert with no app-database clusters", () => {
    // The no-platform-database case: local dev runs guests as child processes of
    // this very server, so nothing has idle-exited and there is nothing to wake.
    const handle = startWorkflowWake({ agents: createMemoryAgentRows(), port: 1234 });
    expect(handle.stop).toBeTypeOf("function");
    // Nothing to assert but that stopping an inert handle is safe.
    expect(() => handle.stop()).not.toThrow();
  });

  test("pollMs of 0 disables the timer", () => {
    const cluster = fakeCluster([], []);
    const handle = startWorkflowWake({
      agents: createMemoryAgentRows(),
      appDbTargets: [cluster],
      port: 1234,
      pollMs: 0,
    });
    expect(() => handle.stop()).not.toThrow();
    expect(cluster.calls).toEqual([]);
  });
});

describe("wakeReachedGuest", () => {
  test("only the two statuses that never brokered count as a miss", () => {
    // The sweep used to discard the status entirely, so a `429` from our OWN
    // limiter — checked BEFORE the handler, so nothing was brokered — and a `503`
    // from a broker that could not boot were both recorded as woken. The run stays
    // due, so the sweep then logged the same false success on every later tick.
    expect(wakeReachedGuest(429)).toBe(false);
    expect(wakeReachedGuest(503)).toBe(false);
    // Every other answer came FROM a live guest (or its own token gate), so the
    // boot — which is the whole action — did happen.
    for (const status of [200, 204, 400, 401, 403, 404, 500]) {
      expect(wakeReachedGuest(status), String(status)).toBe(true);
    }
  });

  test("the internal header token is stable within a process and not a constant", () => {
    // Stable, or the limiter's equality check never matches; per-process, so it
    // cannot be replayed from outside the container that minted it.
    expect(wakeInternalToken()).toBe(wakeInternalToken());
    expect(wakeInternalToken()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
