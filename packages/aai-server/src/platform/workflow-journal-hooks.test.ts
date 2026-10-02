// Copyright 2026 the AAI authors. MIT license.
/**
 * The hook-window statements, against a recorder. Moved from
 * `workflow-journal.test.ts`; the slug-in-every-statement and one-statement-claim
 * invariants stay there, because they are asserted over the whole journal
 * surface at once.
 */

import { describe, expect, test } from "vitest";
import type { SqlExec } from "../sql-exec.ts";
import {
  claimHook,
  closeHook,
  deliverHook,
  PlatformWorkflowHookTokenError,
} from "./workflow-journal-hooks.ts";

const SLUG = "tenant-a";

/** One statement the store issued. */
type Issued = { sql: string; params: unknown[] };

/** A recording `SqlExec` that answers from a queue, one entry per statement. */
function recorder(rows: Record<string, unknown>[][] = []) {
  const issued: Issued[] = [];
  const queue = [...rows];
  const sql: SqlExec = async (query, params = []) => {
    issued.push({ sql: query, params });
    return queue.shift() ?? [];
  };
  return { sql, issued };
}

const HOOK_ROW = { token: "tok", delivered: false, payload: null, closed: false };

describe("claimHook", () => {
  test("is ONE statement, so the ownership check IS the claim", async () => {
    // The ownership `select` and the `insert` used to be two round trips on an
    // untransacted connection, so two runs of one agent claiming the same DERIVED
    // token concurrently both read no owner and the loser tripped
    // `workflow_hooks_token_idx` (23505) instead of the authored refusal. An
    // untargeted `on conflict do nothing` cannot raise that at all, and one
    // statement is what makes the read and the write one decision.
    const { sql, issued } = recorder([[{ ...HOOK_ROW, run_id: "wrun_1", key: "hook!0" }]]);
    await claimHook(sql, SLUG, "wrun_1", "hook!0", "tok");
    expect(issued).toHaveLength(1);
    expect(issued[0]?.sql).toContain("on conflict do nothing");
  });

  test("refuses a token another run holds, naming the holder", async () => {
    // Two waits sharing a token means one signal resolves whichever row the
    // planner reached first and the other waits forever.
    const { sql } = recorder([[{ ...HOOK_ROW, run_id: "wrun_other", key: "hook!0" }]]);
    await expect(claimHook(sql, SLUG, "wrun_1", "hook!0", "tok")).rejects.toThrow(
      /already held by run wrun_other/,
    );
  });

  test("refuses it as a TYPED error, which is what buys the caller a 409", async () => {
    // A plain `Error` reaches `withReserved`'s catch-all and becomes a 503 —
    // "come back later" for a condition that cannot change while the holder is
    // alive, so the guest retries and burns the message's attempt budget on it.
    const { sql } = recorder([[{ ...HOOK_ROW, run_id: "wrun_other", key: "hook!0" }]]);
    await expect(claimHook(sql, SLUG, "wrun_1", "hook!0", "tok")).rejects.toBeInstanceOf(
      PlatformWorkflowHookTokenError,
    );
  });

  test("accepts a re-claim by the SAME run and key, which is what a replay does", async () => {
    const { sql } = recorder([[{ ...HOOK_ROW, run_id: "wrun_1", key: "hook!0" }]]);
    await expect(claimHook(sql, SLUG, "wrun_1", "hook!0", "tok")).resolves.toMatchObject({
      token: "tok",
      delivered: false,
    });
  });
});

describe("closeHook is a compare-and-set", () => {
  test("the update refuses an already-DELIVERED window", async () => {
    // Unconditional, this walk of the body timed out while every later replay
    // read `delivered: true` and answered — the divergence `closed` exists to
    // prevent, arriving by the other door.
    const { sql, issued } = recorder([[{ closed: "1", existing: "1" }]]);
    expect(await closeHook(sql, SLUG, "wrun_1", "hook!0")).toBe(true);
    expect(issued[0]?.sql).toContain("delivered = false");
  });

  test("answers false when the row exists and the update matched nothing", async () => {
    const { sql } = recorder([[{ closed: "0", existing: "1" }]]);
    expect(await closeHook(sql, SLUG, "wrun_1", "hook!0")).toBe(false);
  });

  test("answers true when the window is GONE, a terminal run having released it", async () => {
    // Nothing to refuse, so the caller's timeout stands.
    const { sql } = recorder([[{ closed: "0", existing: "0" }]]);
    expect(await closeHook(sql, SLUG, "wrun_1", "hook!0")).toBe(true);
  });
});

describe("deliverHook", () => {
  test("answers the run it resolved, and binds the payload as text", async () => {
    const { sql, issued } = recorder([[{ run_id: "wrun_1" }]]);
    expect(await deliverHook(sql, SLUG, "tok", `{"ok":true}`)).toBe("wrun_1");
    expect(issued[0]?.params).toEqual([SLUG, "tok", `{"ok":true}`]);
    expect(issued[0]?.sql).toContain("delivered = false and closed = false");
  });

  test("answers undefined for a window already delivered, closed, or unknown", async () => {
    const { sql, issued } = recorder([[]]);
    expect(await deliverHook(sql, SLUG, "tok", undefined)).toBeUndefined();
    expect(issued[0]?.params).toEqual([SLUG, "tok", null]);
  });
});

describe("PlatformWorkflowHookTokenError", () => {
  test("names the holder when one is known", () => {
    expect(new PlatformWorkflowHookTokenError("wrun_9").message).toContain("run wrun_9");
    expect(new PlatformWorkflowHookTokenError(undefined).message).toBe(
      "workflow hook token already held by another wait",
    );
  });
});
