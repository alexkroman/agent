// Copyright 2026 the AAI authors. MIT license.
/**
 * The `aai workflow` command WIRING, as opposed to `workflow.test.ts`, which
 * covers the executors it calls.
 *
 * Worth its own suite because the wiring carries three decisions the executors
 * cannot see. Every verb has to declare `--token`, and a verb that forgot it
 * leaves an operator who set `AAI_WORKFLOW_API_TOKEN` unable to authenticate at
 * all — `findUnknownFlags` rejects the flag before the executor is reached, so
 * the symptom is a rejected flag rather than a missing header. `--limit` is
 * parsed HERE so a non-numeric value is a CLI error naming the flag instead of a
 * query the agent rejects. And the executors are imported LAZILY, which is what
 * keeps the CLI's startup path off this module's dependency graph.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { ok } from "./_output.ts";

const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
}));
vi.mock("./_ui.ts", () => ({ log: logMock, silenceOutput: vi.fn() }));

const executors = vi.hoisted(() => ({
  executeWorkflowList: vi.fn(),
  executeWorkflowRuns: vi.fn(),
  executeWorkflowShow: vi.fn(),
  executeWorkflowCancel: vi.fn(),
  executeWorkflowRetry: vi.fn(),
}));
vi.mock("./workflow.ts", () => executors);

const CWD = "/tmp/some-agent";
vi.mock("./_utils.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_utils.ts")>()),
  resolveCwd: () => CWD,
}));

const { workflow } = await import("./cli-workflow.ts");

/** One verb's citty definition — `subCommands` is a plain object here. */
function verb(name: string): { args: Record<string, unknown>; run: (c: never) => Promise<void> } {
  const subCommands = workflow.subCommands as Record<string, unknown>;
  const found = subCommands[name];
  // A plain throw rather than `expect.fail`, which Biome's `noMisplacedAssertion`
  // rightly rejects outside a test body. The key-set test below is what actually
  // covers a missing verb; this only narrows the type.
  if (found === undefined) throw new Error(`aai workflow declares no "${name}" subcommand`);
  return found as { args: Record<string, unknown>; run: (c: never) => Promise<void> };
}

/** Invoke a verb the way citty does, with `args` already parsed. */
async function run(name: string, args: Record<string, unknown>): Promise<void> {
  await verb(name).run({ args } as never);
}

const VERBS = ["list", "runs", "show", "cancel", "retry"] as const;

// `restoreMocks` covers `vi.spyOn` and not the `vi.fn()`s in a module mock, so
// their call history carries between tests — which the "never calls the
// executor" assertion below reads as a call this test made.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("aai workflow", () => {
  test("declares exactly the five verbs", () => {
    // The set is the CLI's contract with the guides and the changeset; a verb
    // added here without one is undiscoverable.
    expect(Object.keys(workflow.subCommands as Record<string, unknown>).sort()).toEqual(
      [...VERBS].sort(),
    );
  });

  test.each(VERBS)("%s declares --token, --server and --json", (name) => {
    // --token is the load-bearing one: the workflow API takes the AGENT's own
    // bearer, not the caller's API key, so a verb missing it cannot reach a
    // closed agent at all — and the failure is "unknown flag", which reads as a
    // typo rather than as a gap.
    expect(Object.keys(verb(name).args)).toEqual(
      expect.arrayContaining(["token", "server", "json"]),
    );
  });

  test("list forwards the server and the token", async () => {
    executors.executeWorkflowList.mockResolvedValue(ok({ workflows: [] }));
    await run("list", { server: "https://x.test", token: "t0k", json: false });
    expect(executors.executeWorkflowList).toHaveBeenCalledWith(CWD, {
      server: "https://x.test",
      token: "t0k",
    });
  });

  test.each([
    ["show", executors.executeWorkflowShow, { run: { runId: "r1" } }],
    ["cancel", executors.executeWorkflowCancel, { runId: "r1", cancelled: true }],
    ["retry", executors.executeWorkflowRetry, { runId: "r1", retried: true }],
  ])("%s passes the run id through positionally", async (name, executor, data) => {
    executor.mockResolvedValue(ok(data));
    await run(name, { runId: "r1", server: undefined, token: "t0k", json: false });
    expect(executor).toHaveBeenCalledWith(CWD, "r1", { server: undefined, token: "t0k" });
  });

  describe("runs --limit", () => {
    test("parses a numeric limit to a number", async () => {
      // The executor puts it straight into a query string, so a string here
      // would work by coincidence and `--limit 1e3` would not.
      executors.executeWorkflowRuns.mockResolvedValue(ok({ runs: [] }));
      await run("runs", { workflow: "digest", limit: "5", json: false });
      expect(executors.executeWorkflowRuns).toHaveBeenCalledWith(
        CWD,
        "digest",
        expect.objectContaining({ limit: 5 }),
      );
    });

    test("an absent limit stays undefined, so the executor's default applies", async () => {
      executors.executeWorkflowRuns.mockResolvedValue(ok({ runs: [] }));
      await run("runs", { workflow: "digest", json: false });
      expect(executors.executeWorkflowRuns).toHaveBeenCalledWith(
        CWD,
        "digest",
        expect.objectContaining({ limit: undefined }),
      );
    });

    test("a non-numeric limit fails as a CLI error and never calls the executor", async () => {
      // `Number("abc")` is NaN, which would reach the query as `limit=NaN` and
      // come back as an opaque agent-side rejection.
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      await run("runs", { workflow: "digest", limit: "abc", json: false });
      expect(executors.executeWorkflowRuns).not.toHaveBeenCalled();
      expect(logMock.error).toHaveBeenCalledWith("--limit must be a number");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
