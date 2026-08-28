// Copyright 2026 the AAI authors. MIT license.
// The end-of-turn settle and the mid-turn checkpoints, as their own spec.
//
// This module had none: every line of it was covered incidentally by
// `studio-chat.test.ts`'s real turns, so moving those to the scenario tier
// dropped it to 35.2% and `check:coverage-per-file` — whose whole job is
// catching a file the package average cannot see — said so. Incidental
// coverage is what that gate exists to distinguish from the real thing.
//
// `snapshotWorkspace` is MOCKED, and that is the split rather than a shortcut:
// what this module decides is which RPCs go out, with which flags, and how a
// failure is handled. Walking a real tree is `studio-workspace-fs.ts`'s
// subject, and reading one here would only re-test it more slowly.

import { describe, expect, test, vi } from "vitest";
import { installFakeHostChannel } from "./_test-utils.ts";
import { setHostSend } from "./harness-rpc.ts";
import type { StudioSession } from "./studio-session.ts";

const snapshotWorkspace = vi.fn<
  (dir: string) => Promise<{ files: Record<string, string>; warnings: string[] }>
>(() => Promise.resolve({ files: { "agent.ts": "// x" }, warnings: [] }));

vi.mock("./studio-workspace-fs.ts", () => ({
  snapshotWorkspace: (dir: string) => snapshotWorkspace(dir),
}));

const { createWorkspaceCheckpointer, settleTurn } = await import("./studio-turn-settle.ts");

const session: StudioSession = {
  scope: "s",
  project: "p",
  files: {},
  apiKey: "k",
  chatToken: "tok",
  system: "sys",
  model: "fake-1",
  maxSteps: 4,
  dir: "/workspace",
};

/** The guest→host requests a run produced, in order. */
function requestsOf(channel: ReturnType<typeof installFakeHostChannel>): {
  method: string;
  params: unknown;
}[] {
  return channel.sent.flatMap((msg) =>
    "method" in msg && "id" in msg ? [{ method: msg.method, params: msg.params }] : [],
  );
}

describe("settleTurn", () => {
  test("syncs the workspace as TURN-COMPLETE and persists the conversation", async () => {
    const channel = installFakeHostChannel({ autoAnswer: true });
    try {
      await settleTurn(session, []);

      const calls = requestsOf(channel);
      const sync = calls.find((c) => c.method === "studio/sync-workspace");
      // `done: true` is what the host keys auto preview deploys off — a
      // checkpoint shares the method and must never carry it.
      expect(sync?.params).toMatchObject({ files: { "agent.ts": "// x" }, done: true });
      expect(calls.some((c) => c.method === "studio/persist-chat")).toBe(true);
      expect(snapshotWorkspace).toHaveBeenCalledWith("/workspace");
    } finally {
      setHostSend(null);
    }
  });

  test("reports a walk's warnings rather than dropping them", async () => {
    const channel = installFakeHostChannel({ autoAnswer: true });
    const errors = vi.spyOn(console, "error").mockReturnValue(undefined);
    snapshotWorkspace.mockResolvedValueOnce({ files: {}, warnings: ["skipped huge.bin"] });
    try {
      await settleTurn(session, []);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("skipped huge.bin"));
      // And the sync still goes out: a warning is about one FILE, not the turn.
      expect(requestsOf(channel).some((c) => c.method === "studio/sync-workspace")).toBe(true);
    } finally {
      setHostSend(null);
    }
  });
});

describe("createWorkspaceCheckpointer", () => {
  test("syncs WITHOUT the done flag, so a half-finished turn is not deployed", async () => {
    const channel = installFakeHostChannel({ autoAnswer: true });
    try {
      const checkpoint = createWorkspaceCheckpointer(session);
      checkpoint();
      await vi.waitFor(() => {
        const sync = requestsOf(channel).find((c) => c.method === "studio/sync-workspace");
        expect(sync).toBeDefined();
        expect(sync?.params).not.toHaveProperty("done");
      });
    } finally {
      setHostSend(null);
    }
  });

  test("coalesces a burst into one trailing run rather than a backlog", async () => {
    const channel = installFakeHostChannel({ autoAnswer: true });
    snapshotWorkspace.mockClear();
    try {
      const checkpoint = createWorkspaceCheckpointer(session);
      // A long tool chain: nine more triggers while the first walk is in
      // flight. The runner's contract is at most ONE trailing run for them —
      // the snapshot reads the tree as it stands, so queueing each would be
      // work whose result the next one overwrites.
      for (let i = 0; i < 10; i++) checkpoint();
      await vi.waitFor(() => {
        expect(requestsOf(channel).length).toBeGreaterThanOrEqual(1);
      });
      expect(snapshotWorkspace.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      setHostSend(null);
    }
  });

  test("a failed checkpoint is logged, never thrown — a good reply survives it", async () => {
    const channel = installFakeHostChannel({ autoAnswer: true });
    const errors = vi.spyOn(console, "error").mockReturnValue(undefined);
    snapshotWorkspace.mockRejectedValueOnce(new Error("tree vanished"));
    try {
      const checkpoint = createWorkspaceCheckpointer(session);
      // Synchronous by contract: the caller is a tool-result handler mid-turn,
      // and a throw here would take down a reply that is otherwise fine.
      expect(() => checkpoint()).not.toThrow();
      await vi.waitFor(() => {
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("tree vanished"));
      });
      expect(requestsOf(channel)).toEqual([]);
    } finally {
      setHostSend(null);
    }
  });
});
