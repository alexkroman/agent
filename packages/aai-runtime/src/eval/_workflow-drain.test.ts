// Copyright 2026 the AAI authors. MIT license.
/**
 * The drain `settleAll` runs and the warning `close()` gives for a run nothing
 * drained, driven through `openEvalWorkflows` — the one caller, and the only
 * way to hold a body open while it is observed.
 */

import { agent, workflow } from "@alexkroman1/aai";
import { stepReport } from "@alexkroman1/aai/step";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { type EvalWorkflows, openEvalWorkflows } from "./workflows.ts";

/** Closed after every test — `openEvalWorkflows` publishes process-global slots. */
let open: EvalWorkflows | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe("draining a run that is still in flight", () => {
  /** A body held open by the case, which is the only way to observe one live. */
  function heldApp(): { active: EvalWorkflows; release: () => void } {
    const gate = Promise.withResolvers<void>();
    const held = workflow({
      input: z.object({}),
      run: async () => {
        await gate.promise;
        return { ok: true };
      },
    });
    const active = openEvalWorkflows({
      agent: agent({ name: "Held", mode: "workflow-app", workflows: { held } }),
      env: {},
    });
    open = active;
    return { active, release: () => gate.resolve() };
  }

  test("`settleAll` waits for a run nothing else was waiting for", async () => {
    const { active, release } = heldApp();
    const runId = await active.client.start("held", {});
    // The state a case is in while it holds a provider response: the run is
    // live, and `run()` never saw it because a tool started it.
    expect((await active.runs())[0]?.status).toBe("running");
    release();
    const settled = await active.settleAll();
    expect(settled.map((one) => one.runId)).toEqual([runId]);
    expect(settled[0]?.completed).toBe(true);
  });

  test("a run started WHILE draining is drained too", async () => {
    let spawner: EvalWorkflows | undefined;
    const child = workflow({ input: z.object({}), run: async () => ({ child: true }) });
    const parent = workflow({
      input: z.object({}),
      run: async () => {
        await spawner?.client.start("child", {});
        return { parent: true };
      },
    });
    const active = openEvalWorkflows({
      agent: agent({ name: "Spawner", mode: "workflow-app", workflows: { parent, child } }),
      env: {},
    });
    open = active;
    spawner = active;
    await active.client.start("parent", {});
    // The child does not exist when the walk begins, and it is exactly the run
    // a snapshot of `records()` would abandon.
    const settled = await active.settleAll();
    expect(settled.map((one) => one.workflow)).toEqual(["parent", "child"]);
  });

  test("`close()` after a drain is SILENT — the warning is about a real leak", async () => {
    const { active, release } = heldApp();
    await active.client.start("held", {});
    release();
    await active.settleAll();
    const warned = vi.spyOn(process, "emitWarning").mockReturnValue(undefined);
    await active.close();
    open = undefined;
    expect(warned).not.toHaveBeenCalled();
  });

  test("`close()` NAMES the abandoned run and what it was last doing", async () => {
    const gate = Promise.withResolvers<void>();
    const narrating = workflow({
      input: z.object({}),
      run: async () => {
        await stepReport("halfway through");
        await gate.promise;
        return { ok: true };
      },
    });
    const active = openEvalWorkflows({
      agent: agent({ name: "Narrating", mode: "workflow-app", workflows: { narrating } }),
      env: {},
    });
    const runId = await active.client.start("narrating", {});
    await vi.waitFor(async () => {
      expect((await active.runs())[0]?.reported).toEqual(["halfway through"]);
    });
    const warned = vi.spyOn(process, "emitWarning").mockReturnValue(undefined);
    await active.close();
    const [message] = warned.mock.calls[0] ?? [];
    expect(message).toContain(runId);
    expect(message).toContain("narrating");
    // The last progress line, because it is the only part of an abandoned run
    // that says where it got to.
    expect(message).toContain("halfway through");
    expect(message).toContain("settleAll");
    // Released so the body cannot outlive this file's other cases — the very
    // leak the warning is about.
    gate.resolve();
    await active.settleAll();
  });
});
