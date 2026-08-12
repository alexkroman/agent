// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai dev` runs a durable workflow end to end.
 *
 * This is the one test that exercises the whole chain rather than a link of it,
 * and every link in it has already been wrong once:
 *
 * - the WDK client transform, without which the agent's own copy of a body
 *   carries no `workflowId` and `ctx.workflows.start` throws;
 * - the two builder outputs being ROUTE MODULES, not raw workflow code — handing
 *   the flow module to `workflowEntrypoint` compiles it in a `node:vm` Script
 *   and every run dies at replay;
 * - the import rewrite, without which a bundle loaded from `/tmp` cannot resolve
 *   `workflow`;
 * - the world being configured BEFORE anything imports `workflow/runtime`;
 * - the three routes being mounted on the dev server at all.
 *
 * Each of those has a unit spec of its own, and NONE of them fails when a
 * neighbouring one does: a run that never completes is the only symptom the
 * chain has, and it is invisible to every layer's own suite.
 *
 * The run is driven through the DevKit's own `start`, not through a voice
 * session — a session would add STT/LLM/TTS credentials to a test about
 * durability. It is the same call `ctx.workflows.start` makes (`workflow-wdk.ts`),
 * with the id read off the built bundle exactly as `createWorkflowClient` reads
 * it, so the seam between them is asserted rather than assumed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import getPort, { portNumbers } from "get-port";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createWorkerEvaluator } from "./_bundler.ts";
import { loadWorker, startDevServer } from "./_dev-server.ts";

/**
 * The fixture lives INSIDE this package, not in `os.tmpdir()`.
 *
 * Both bundlers resolve `workflow` by walking up from the project, and a temp
 * directory's walk-up reaches `/node_modules` and stops. The failure is
 * esbuild's `Could not resolve "workflow"`, which reads as a broken builder
 * config rather than a misplaced fixture.
 */
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".dev-workflow-fixture");

/** Short enough to wait out in a test; the mechanism is identical at six hours. */
const SLEEP = "1 second";

const AGENT_TS = `
import { agent, tool, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { researchFlow } from "./workflows/research.ts";

export const research = workflow({
  description: "Research a topic",
  input: z.object({ topic: z.string() }),
  run: researchFlow,
});

export default agent({
  name: "dev-workflow-fixture",
  greeting: "hi",
  systemPrompt: "fixture",
  workflows: { research },
  tools: {},
});
`;

const WORKFLOW_TS = `
import { sleep } from "workflow";

export async function researchFlow(input: { topic: string }) {
  "use workflow";
  const findings = await gather(input.topic);
  // The suspension is the point: it is what a tool cannot do, and it is what
  // makes the resume path (a second flow-route call) part of this test.
  await sleep(${JSON.stringify(SLEEP)});
  return { topic: findings.topic, sources: findings.sources };
}

async function gather(topic: string) {
  "use step";
  return { topic, sources: 3 };
}
`;

async function writeFixture(): Promise<void> {
  await fs.rm(FIXTURE, { recursive: true, force: true });
  await fs.mkdir(path.join(FIXTURE, "workflows"), { recursive: true });
  await fs.writeFile(path.join(FIXTURE, "agent.ts"), AGENT_TS);
  await fs.writeFile(path.join(FIXTURE, "workflows", "research.ts"), WORKFLOW_TS);
  await fs.writeFile(
    path.join(FIXTURE, "package.json"),
    JSON.stringify({ name: "dev-workflow-fixture", type: "module", private: true }),
  );
}

describe("aai dev serves a durable workflow", () => {
  let stop: (() => Promise<void>) | undefined;
  let workflowId: string | undefined;

  beforeAll(async () => {
    await writeFixture();
    // A provider key has to be resolvable or `resolveAgentEnv` reaches for the
    // logged-in one; the value is never dialled, since no session is opened.
    process.env.ASSEMBLYAI_API_KEY ??= "not-used-by-this-test";
    const port = await getPort({ port: portNumbers(4700, 4799) });
    stop = await startDevServer({ cwd: FIXTURE, port });
  }, 120_000);

  afterAll(async () => {
    await stop?.();
    await fs.rm(FIXTURE, { recursive: true, force: true });
  });

  test("the built agent bundle carries the compiler's workflowId", async () => {
    // What `ctx.workflows.start` reads. Undefined here means the client
    // transform did not run, which is a bundle that serves every workflow route
    // and cannot start a run.
    const worker = await loadWorker(FIXTURE, createWorkerEvaluator());
    const def = worker.agent.workflows?.research;
    workflowId = def?.run.workflowId;
    expect(workflowId).toBeTruthy();
    // Both halves present, or the guest mounts no surface at all.
    expect(typeof worker.workflowCode).toBe("string");
    expect(typeof worker.stepCode).toBe("string");
  });

  test("a run started against that id completes with the workflow's output", async () => {
    expect(workflowId).toBeTruthy();
    // The world is process-global and the dev server configured it, so this
    // reaches the same local world the server's routes serve.
    const { getRun, start } = await import("workflow/api");
    const { getWorld } = await import("workflow/runtime");

    const run = await start({ workflowId: workflowId as string }, [{ topic: "otters" }]);

    // Polled rather than `vi.waitFor`ed on a fixed delay: the run's own
    // one-second sleep dominates, and the statuses in between are what a
    // half-wired chain gets stuck in ("pending" forever with nothing logged).
    await expect
      .poll(async () => (await getWorld().runs.get(run.runId, { resolveData: "none" })).status, {
        timeout: 25_000,
        interval: 250,
      })
      .toBe("completed");

    expect(await getRun(run.runId).returnValue).toEqual({ topic: "otters", sources: 3 });
  });
});
