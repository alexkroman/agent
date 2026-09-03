// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the `aai workflow` subcommand GROUP — its wiring, not its
 * executors (those are in `workdialog.test.ts`).
 *
 * Two things live at this layer and nowhere else: the four verbs being reachable
 * at all, and `--limit` being parsed here so a non-numeric value fails as a CLI
 * error naming the flag rather than as a query the agent rejects three hops
 * away.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { workflow } from "./cli-workflow.ts";

const executors = vi.hoisted(() => ({
  executeWorkflowList: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  executeWorkflowRuns: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  executeWorkflowShow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  executeWorkflowCancel: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));
vi.mock("./workflow.ts", () => executors);

// The executor mocks are module-level `vi.fn()`s, and `restoreMocks: true`
// registers only `vi.spyOn` mocks — it clears neither their history nor their
// implementation. Uncleared, `not.toHaveBeenCalled()` below is a statement
// about file order rather than about the case, and a `toHaveBeenCalledWith`
// can be satisfied by an earlier test's call.
beforeEach(() => {
  vi.clearAllMocks();
});

const subs = workflow.subCommands as Record<
  string,
  { args?: Record<string, unknown>; run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
>;

describe("the workflow command group", () => {
  test.each(["list", "runs", "show", "cancel"])("declares the %s verb", (name) => {
    expect(subs[name]).toBeDefined();
  });

  test("every verb takes --token, --server, --agent and --json", () => {
    for (const [name, cmd] of Object.entries(subs)) {
      expect(cmd.args, name).toMatchObject({
        token: expect.anything(),
        server: expect.anything(),
        agent: expect.anything(),
        json: expect.anything(),
      });
    }
  });

  test("--agent REACHES every executor, not just the ones it was added to", async () => {
    // Declaring a flag and forwarding it are separate edits, and there are four
    // verbs — the shape this suite exists for. A verb that declares `--agent`
    // and drops it on the way to the executor silently targets the platform,
    // i.e. asks for `aai publish` while a dev server is answering.
    const url = "http://localhost:3000";
    await subs.list?.run({ args: { agent: url, json: false } });
    await subs.runs?.run({ args: { workflow: "digest", agent: url, json: false } });
    await subs.show?.run({ args: { runId: "wrun_1", agent: url, json: false } });
    await subs.cancel?.run({ args: { runId: "wrun_1", agent: url, json: false } });
    // The options bag is every executor's LAST parameter — the one thing the
    // four signatures share, `runs` and `show` carrying a positional before it.
    for (const [name, exec] of Object.entries(executors)) {
      const args = exec.mock.calls[0] as unknown[];
      expect(args.at(-1), name).toMatchObject({ agent: url });
    }
  });

  test("--limit is parsed here, so a bad value names the FLAG", async () => {
    // `runCommand` turns the CliError into a printed failure and a non-zero
    // exit, which vitest surfaces as a rejection — what matters is that the
    // request is never made and the message names `--limit` rather than being
    // whatever the agent says about an unparseable query.
    // `json: false` keeps human mode, where `runCommand` prints the message;
    // JSON mode silences every `log` method for the rest of the process.
    const { log } = await import("./_ui.ts");
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    await expect(
      subs.runs?.run({ args: { workflow: "digest", limit: "lots", json: false } }),
    ).rejects.toThrow(/process\.exit/);
    expect(error).toHaveBeenCalledWith("--limit must be a number");
    expect(executors.executeWorkflowRuns).not.toHaveBeenCalled();
  });

  test("a numeric --limit reaches the executor as a number", async () => {
    await subs.runs?.run({ args: { workflow: "digest", limit: "3", json: false } });
    expect(executors.executeWorkflowRuns).toHaveBeenCalledWith(
      expect.any(String),
      "digest",
      expect.objectContaining({ limit: 3 }),
    );
  });

  test("an absent --limit stays undefined rather than becoming NaN", async () => {
    await subs.runs?.run({ args: { workflow: "digest", json: false } });
    expect(executors.executeWorkflowRuns).toHaveBeenCalledWith(
      expect.any(String),
      "digest",
      expect.objectContaining({ limit: undefined }),
    );
  });
});
