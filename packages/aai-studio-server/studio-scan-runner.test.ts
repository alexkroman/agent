// Copyright 2026 the AAI authors. MIT license.
// These tests exercise the REAL worker thread — spawn, job multiplexing,
// error rehydration, and the terminate deadline — because the deadline is
// the security property: a mocked worker would prove nothing about whether
// a spinning regex actually dies.

import { afterAll, describe, expect, test } from "vitest";
import { StudioEditError } from "./studio-edit.ts";
import { StudioGrepError } from "./studio-grep.ts";
import {
  _shutdownScanWorker,
  applyEditInWorker,
  grepWorkspaceInWorker,
  SCAN_JOB_TIMEOUT_MS,
} from "./studio-scan-runner.ts";

const FILES = {
  "agent.ts": "const rollDice = tool({});\nexport default {};\n",
  "notes.md": "rollDice is the dice tool\n",
};

afterAll(() => _shutdownScanWorker());

describe("grepWorkspaceInWorker", () => {
  test("returns the same output shape as the sync implementation", async () => {
    const out = await grepWorkspaceInWorker(FILES, "rollDice");
    expect(out).toContain("agent.ts:1: const rollDice = tool({});");
    expect(out).toContain("notes.md:1: rollDice is the dice tool");
  });

  test("options survive the thread boundary", async () => {
    const out = await grepWorkspaceInWorker(FILES, "ROLLDICE", {
      ignoreCase: true,
      glob: "*.ts",
    });
    expect(out).toContain("agent.ts:1:");
    expect(out).not.toContain("notes.md");
  });

  test("an invalid regex comes back as a StudioGrepError, not a wire artifact", async () => {
    await expect(grepWorkspaceInWorker(FILES, "[unclosed")).rejects.toThrow(StudioGrepError);
    await expect(grepWorkspaceInWorker(FILES, "[unclosed")).rejects.toThrow(/literal: true/);
  });

  test("a catastrophically backtracking pattern is terminated, and the worker recovers", async () => {
    // Exponential backtracking explodes at tens of characters — far under
    // grep's long-line skip — and would pin the main thread forever if it
    // ran there (the per-tool pTimeout can't fire while the loop is pinned).
    // Off-thread, the terminate deadline must kill it...
    const bait = { "a.ts": `${"a".repeat(60)}!` };
    const start = Date.now();
    await expect(grepWorkspaceInWorker(bait, "(a+)+$")).rejects.toThrow(StudioGrepError);
    await expect(grepWorkspaceInWorker(bait, "(a+)+$")).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(SCAN_JOB_TIMEOUT_MS * 2 + 5000);
    // ...and the next call must get a fresh worker, not a dead one.
    await expect(grepWorkspaceInWorker(FILES, "rollDice")).resolves.toContain("agent.ts:1:");
  }, 30_000);

  test("concurrent jobs multiplex over one worker", async () => {
    const [a, b, c] = await Promise.all([
      grepWorkspaceInWorker(FILES, "rollDice"),
      grepWorkspaceInWorker(FILES, "export"),
      grepWorkspaceInWorker(FILES, "absent-needle"),
    ]);
    expect(a).toContain("agent.ts:1:");
    expect(b).toContain("agent.ts:2:");
    expect(c).toBe("No matches found");
  });
});

describe("applyEditInWorker", () => {
  test("applies an edit and returns the diffed result", async () => {
    const { content, diff, replacements } = await applyEditInWorker(
      "agent.ts",
      FILES["agent.ts"],
      "rollDice",
      "rollD20",
    );
    expect(content).toContain("rollD20");
    expect(diff).toContain("rollD20");
    expect(replacements).toBe(1);
  });

  test("a missing match comes back as a StudioEditError", async () => {
    await expect(applyEditInWorker("agent.ts", FILES["agent.ts"], "absent", "x")).rejects.toThrow(
      StudioEditError,
    );
  });
});
