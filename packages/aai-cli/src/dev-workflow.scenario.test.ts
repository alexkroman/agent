// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai dev` runs a durable workflow end to end.
 *
 * This is the one test that exercises the whole chain rather than a link of it,
 * and every link in it has already been wrong once:
 *
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
 * Runs are driven through the workflow HTTP API rather than through a voice
 * session — a session would add STT/LLM/TTS credentials to a test about
 * durability.
 *
 * **A block asserting the COMPILER's `workflowId` was here and is gone.** It
 * read the id off the built bundle the way `createWorkflowClient` used to, and
 * started a run with the DevKit's own `start({ workflowId })`. There is no such
 * id any more: a workflow is identified by the key it is declared under in
 * `agent({ workflows })`, which cannot go missing because the declaration IS the
 * registration. Nothing behavioural went with it — the HTTP suite below starts
 * runs, waits them out and reads their output through the routes a real caller
 * uses, which is the stronger claim.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import getPort, { portNumbers } from "get-port";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { startDevServer } from "./_dev-server.ts";

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
const SLEEP_MS = 1000;

const AGENT_TS = `
import { agent, tool, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { researchFlow } from "./workflows/research.ts";
import { fanOutFlow } from "./workflows/fan-out.ts";
import { secretFlow } from "./workflows/secret.ts";
import { narrateFlow } from "./workflows/narrate.ts";

export const research = workflow({
  description: "Research a topic",
  input: z.object({ topic: z.string().min(1).describe("What to research") }),
  run: researchFlow,
});

export const fanOut = workflow({
  description: "Fan out over a list through a bounded window",
  input: z.object({ words: z.array(z.string()) }),
  run: fanOutFlow,
});

export const secret = workflow({
  description: "Read the agent env from inside a step",
  input: z.object({}),
  run: secretFlow,
});

export const narrate = workflow({
  description: "Narrate to one stream and emit results to another",
  input: z.object({ items: z.array(z.string()) }),
  run: narrateFlow,
});

export default agent({
  name: "dev-workflow-fixture",
  greeting: "hi",
  systemPrompt: "fixture",
  workflows: { research, fanOut, secret, narrate },
  requiredEnv: ["FIXTURE_STEP_TOKEN"],
});
`;

const WORKFLOW_TS = `
import type { WorkflowContext } from "@alexkroman1/aai";
import { stepReport } from "@alexkroman1/aai/step";

export async function researchFlow(input: { topic: string }, ctx: WorkflowContext) {
  const findings = await ctx.step("gather", () => gather(input.topic));
  // The suspension is the point: it is what a tool cannot do, and it is what
  // makes the resume path (a second delivery) part of this test.
  await ctx.sleep("settle", ${SLEEP_MS});
  await ctx.step("file", () => file(findings.topic));
  return { topic: findings.topic, sources: findings.sources };
}

async function gather(topic: string) {
  await stepReport("gathering " + topic);
  return { topic, sources: 3 };
}

// A step AFTER the sleep, so the progress assertion covers a stream written
// across a suspension — the run resumes in a fresh delivery and has to append to
// the same stream rather than starting a new one.
async function file(topic: string) {
  await stepReport("filed " + topic);
}
`;

/**
 * **The webhook fixture is GONE, and its absence is now a HOLE rather than a
 * gap.**
 *
 * It parked on `createWebhook()` and was resumed by a real HTTP delivery — the
 * one thing no unit test can reach. It was dropped while the engine's
 * equivalent, `ctx.waitFor(token)` ended by `ctx.workflows.signal(token,
 * payload)`, had no route in front of it: the note here used to say
 * `/.well-known/workflow/v1/webhook/:token` still reached the DevKit's own hook
 * table and answered `HookNotFound`, which was true when it was written.
 *
 * It is not true any more. `createWebhookHandler` (aai-runtime's
 * `workflow-webhook.ts`) answers that path from `WorkflowClient.signal`, and
 * `createRuntimeServer` mounts it — so `aai dev` serves it and this tier can reach it
 * with a plain POST. Restoring a `waitFor` fixture and delivering to that URL is
 * the missing case, and it is the ONE thing in the durable path that no cheaper
 * tier can cover.
 */

/**
 * A fan-out through `mapConcurrent` — the SDK primitive `transcription-workflow`
 * maps its segments with.
 *
 * This is the only tier that can say whether that primitive is legal at all.
 * `mapConcurrent` calls `ctx.step` from inside a helper in ANOTHER MODULE, so
 * what this checks is that the journal really sees nine distinct entries when the
 * calls are issued from a callback rather than written out in the body. Under the
 * DevKit the same fixture asked a harder question — whether the transform's
 * rewrite was declaration-side or call-site — which `ctx.step` makes unaskable:
 * a step is a call, and a call is a call wherever it is written.
 *
 * Two things about the shape are deliberate, and both are about the CURSOR that
 * makes the window replay-safe: **more items than the width** (nine against
 * three), so most calls are issued only after an earlier one has settled, and
 * **durations that shuffle the settle order**, so completion order is neither the
 * issue order nor its reverse — item 4 lands first and item 0 last. A fan-out that
 * fits in one window exercises none of that.
 *
 * **What this does NOT prove is the replay property itself**, and the distinction
 * is worth keeping: a healthy run is not a resume, so nothing here re-executes the
 * body against an existing journal. That the issue order is a pure function of the
 * list — the thing the DevKit's Nth-call-gets-the-Nth-id correlation needs — is
 * asserted directly, at every width and under reversed and shuffled settle orders,
 * in `aai/sdk/map-concurrent.test.ts`. This tier's job is the half a unit test
 * cannot reach: that these are REAL steps, dispatched through the transform from
 * inside an SDK helper.
 */
const FAN_OUT_TS = `
import type { WorkflowContext } from "@alexkroman1/aai";
import { mapConcurrent } from "@alexkroman1/aai/step";

export async function fanOutFlow(input: { words: string[] }, ctx: WorkflowContext) {
  return {
    shouted: await mapConcurrent(input.words, 3, (word, index) =>
      ctx.step("shout", () => shout(word, index)),
    ),
  };
}

async function shout(word: string, index: number) {
  // Neither issue order nor its reverse: the settle order is shuffled against
  // both, which is what a replay's different timings look like.
  const delays = [90, 30, 60, 10, 5, 70, 20, 50, 40];
  await new Promise((resolve) => setTimeout(resolve, delays[index] ?? 10));
  return word.toUpperCase();
}
`;

/**
 * The SDK's own two narration channels, against a real world.
 *
 * `stepReport()` and `stepEmit()` write to the same run through the same published
 * reporter, and what separates them is a DevKit namespace — which is precisely
 * the part a mocked `getWritable` cannot check. If the namespace did not really
 * key a distinct stream, the two would land in one and a page reading progress
 * would render `[object Object]` between its lines.
 *
 * It also exercises them from inside a `mapConcurrent` fan-out, which is where a
 * real template calls them from.
 */
const NARRATE_TS = `
import type { WorkflowContext } from "@alexkroman1/aai";
import { stepEmit, mapConcurrent, stepReport } from "@alexkroman1/aai/step";

export async function narrateFlow(input: { items: string[] }, ctx: WorkflowContext) {
  const seen = await mapConcurrent(input.items, 2, (item, index) =>
    ctx.step("handle", () => handle(item, index)),
  );
  return { seen };
}

async function handle(item: string, index: number) {
  await stepReport("handling " + item);
  await stepEmit("results", { index, shouted: item.toUpperCase() });
  return item.toUpperCase();
}
`;

/**
 * A step reading the agent env — the property `sdk/step-env.test.ts` says it
 * cannot assert.
 *
 * The whole seam is a `Symbol.for` global, and the reason it has to be one is
 * that the STEP BUNDLE carries its own copy of `sdk/step-env.ts`: the WDK
 * builder externalizes only `workflow` and `@workflow/*`, so the module the
 * dev server publishes into and the module this step reads from are two
 * different instances. Nothing below this tier has two of them.
 *
 * `FIXTURE_STEP_TOKEN` is declared only in the fixture's `.env`, never in
 * `process.env`, so `stepEnv`'s unpublished-slot fallback cannot answer for it
 * — if the global does not cross the bundle boundary this run fails.
 */
const SECRET_TS = `
import type { WorkflowContext } from "@alexkroman1/aai";
import { requireStepEnv, stepEnv } from "@alexkroman1/aai/step";

export async function secretFlow(_input: Record<string, unknown>, ctx: WorkflowContext) {
  return await ctx.step("readSecret", () => readSecret());
}

async function readSecret() {
  return {
    token: requireStepEnv("FIXTURE_STEP_TOKEN"),
    undeclared: stepEnv("FIXTURE_ABSENT_KEY") ?? "absent",
  };
}
`;

async function writeFixture(): Promise<void> {
  await fs.rm(FIXTURE, { recursive: true, force: true });
  await fs.mkdir(path.join(FIXTURE, "workflows"), { recursive: true });
  await fs.writeFile(path.join(FIXTURE, "agent.ts"), AGENT_TS);
  await fs.writeFile(path.join(FIXTURE, "workflows", "research.ts"), WORKFLOW_TS);
  await fs.writeFile(path.join(FIXTURE, "workflows", "fan-out.ts"), FAN_OUT_TS);
  await fs.writeFile(path.join(FIXTURE, "workflows", "secret.ts"), SECRET_TS);
  await fs.writeFile(path.join(FIXTURE, "workflows", "narrate.ts"), NARRATE_TS);
  // The agent env `stepEnv` answers from. `resolveAgentEnv` surfaces DECLARED
  // keys only, so this file is both the declaration and the value.
  await fs.writeFile(path.join(FIXTURE, ".env"), "FIXTURE_STEP_TOKEN=from-dot-env\n");
  await fs.writeFile(
    path.join(FIXTURE, "package.json"),
    JSON.stringify({ name: "dev-workflow-fixture", type: "module", private: true }),
  );
}

/**
 * ONE dev server for the whole file, at module scope rather than inside the
 * `describe` — building the fixture and booting it is the expensive part, and a
 * `beforeAll` nested in a block would have to be repeated by the next one added.
 */
let stop: (() => Promise<void>) | undefined;
let origin = "";

/**
 * A provider key has to be resolvable or `resolveAgentEnv` reaches for the
 * logged-in one; the value is never dialled, since no session is opened.
 *
 * SET, not defaulted. This tier runs under `vitest.slow.config.ts`, which
 * declares no `setupFiles` — so `_test-setup.ts` never runs here and the
 * `??=` this replaces left a developer's REAL key in the fixture server's
 * runtime env. Nothing dials it, so it was not a leak; it was exactly the
 * machine-dependence that setup file exists to remove. Re-stubbed per test
 * because `unstubEnvs` reverts it before each one.
 */
const FAKE_PROVIDER_KEY = "not-used-by-this-test";
beforeEach(() => {
  vi.stubEnv("ASSEMBLYAI_API_KEY", FAKE_PROVIDER_KEY);
});

beforeAll(async () => {
  await writeFixture();
  vi.stubEnv("ASSEMBLYAI_API_KEY", FAKE_PROVIDER_KEY);
  const port = await getPort({ port: portNumbers(4700, 4799) });
  // The fixture has no `client.tsx`, so the backend owns the port directly — no
  // Vite in front, and the HTTP API below is reached without a proxy.
  origin = `http://127.0.0.1:${port}`;
  stop = await startDevServer({ cwd: FIXTURE, port });
}, 120_000);

afterAll(async () => {
  await stop?.();
  await fs.rm(FIXTURE, { recursive: true, force: true });
});

/**
 * The workflow HTTP API, over the same dev server.
 *
 * This is the only tier that can exercise it end to end. `host/workflow-api.
 * test.ts` drives the routes against a STUB `ctx.workflows`; here every link is
 * real — the CLI's bundlers, the replay engine, its journal, the in-process
 * dispatcher and the routes — and a run genuinely suspends on a `sleep` and is
 * walked again when its timer fires. A break anywhere in that chain shows up as
 * a run that never completes, which is invisible to every layer's own suite.
 *
 * What it does NOT reach is a run parked on a WEBHOOK — see the stated gap in
 * this file's module doc.
 */
describe("aai dev serves the workflow HTTP API", () => {
  /** `fetch` + parse, always — an unread body holds its socket open. */
  async function api(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${origin}${path}`, init);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const JSON_POST = { "Content-Type": "application/json" };

  test("lists every declared workflow with the schema a page renders a form from", async () => {
    const { status, body } = await api("/workflows");
    expect(status).toBe(200);
    const workflows = body.workflows as { name: string; inputSchema?: unknown }[];
    expect(workflows.map((w) => w.name).sort((a, b) => a.localeCompare(b))).toEqual([
      "fanOut",
      "narrate",
      "research",
      "secret",
    ]);
    // The zod schema, converted at listing time because the reader is a browser.
    // `<WorkflowFields>` renders one control per property of this.
    expect(workflows.find((w) => w.name === "research")?.inputSchema).toMatchObject({
      type: "object",
      properties: { topic: { description: "What to research" } },
    });
  });

  test("`wait` returns the finished run in ONE POST", async () => {
    // One request in, one result out: the run is started, executed and settled
    // while the request is held open. It used to park on a webhook mid-request,
    // which made it a round-trip test too — see the webhook note above for why
    // that half is gone.
    const { status, body } = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "secret", input: {}, wait: 30_000 }),
    });

    expect(status).toBe(200);
    expect(body.run).toMatchObject({
      status: "completed",
      output: { token: "from-dot-env", undeclared: "absent" },
    });
  }, 40_000);

  test("the run id it hands back reads the same run afterwards", async () => {
    const started = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "secret", input: {}, wait: 30_000 }),
    });
    const runId = started.body.runId as string;

    const { status, body } = await api(`/workflows/runs/${runId}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ runId, status: "completed" });
  }, 40_000);

  test("an asynchronous start is waited out by the READ instead", async () => {
    // The other half of the same mechanism, and the one a caller reaches for
    // after a POST whose budget expired: start without waiting (202), then hold
    // ONE request open until the run settles.
    const started = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "research", input: { topic: "kelp" } }),
    });
    expect(started.status).toBe(202);
    const runId = started.body.runId as string;

    const finished = await api(`/workflows/runs/${runId}?wait=30000`);
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ status: "completed", output: { topic: "kelp" } });

    // The KEYLESS read (`ctx.workflows.recent`), against a real run store — the
    // only tier that can check it. It filtered by the DECLARED name where WDK
    // stores the compiler's identifier, so it answered `[]` for every workflow
    // and `aai workflow runs <name>` printed "No runs of X yet" for every
    // agent; a stubbed adapter answers with whatever name the test wrote, so no
    // unit spec could see it.
    const listed = await api("/workflows/runs?workflow=research&limit=10");
    expect(listed.status).toBe(200);
    const runs = listed.body.runs as { runId: string; workflow: string }[];
    expect(runs.map((r) => r.runId)).toContain(runId);
    // And the name each snapshot reports is the key the agent declares it
    // under, not `workflow//./workflows/research//researchFlow` — which
    // `research-workflow`'s status tool reads to a caller down the phone.
    expect(runs.every((r) => r.workflow === "research")).toBe(true);
  }, 40_000);

  test("a bounded fan-out through `mapConcurrent` runs its steps for real", async () => {
    // Two things at once, and only the first is about the array. Results in ITEM
    // order although the steps settle in a shuffled one; and every one of them
    // dispatched as a genuine step through the transform while being called from
    // an SDK helper rather than from the body's own source. Nine items through a
    // window of three is what makes the cursor do any work — see `FAN_OUT_TS`,
    // which also says what this tier deliberately does not prove.
    const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    const { status, body } = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "fanOut", input: { words }, wait: 30_000 }),
    });

    expect(status).toBe(200);
    expect(body.run).toMatchObject({
      status: "completed",
      output: { shouted: words.map((word) => word.toUpperCase()) },
    });
  }, 40_000);

  test("a step reads the agent env, across the bundle boundary", async () => {
    // See `SECRET_TS`. The key is in the fixture's `.env` and nowhere else, so
    // a slot that did not cross from the dev server's copy of the SDK to the
    // step bundle's copy fails this run rather than degrading.
    const { status, body } = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "secret", input: {}, wait: 30_000 }),
    });

    expect(status).toBe(200);
    expect(body.run).toMatchObject({
      status: "completed",
      // `undeclared` is the other half of the contract: once an env is
      // published there is no per-key fallback, so a key the agent does not
      // declare reads as absent rather than as whatever the host exported.
      output: { token: "from-dot-env", undeclared: "absent" },
    });
  }, 40_000);

  test("streams the progress a run WROTE, across its suspension", async () => {
    // The half no unit test can reach: `getWritable()` throws outside a run, so
    // only a real transform, a real world and the real route can prove a line
    // written in a step comes back out of `GET /runs/:id/stream`. It also spans
    // the `sleep` — the second line is written by a step that runs in a FRESH
    // flow-route call after the resume, and has to append to the same stream.
    const started = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "research", input: { topic: "otters" }, wait: 30_000 }),
    });
    const runId = started.body.runId as string;

    // Read AFTER the run finished, which is the replay property: chunks are
    // retained with the run, so a page that arrives late sees all of them.
    const response = await fetch(`${origin}/workflows/runs/${runId}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const body = await response.text();

    expect(body).toContain('event: chunk\ndata: "gathering otters"');
    expect(body).toContain('event: chunk\ndata: "filed otters"');
    // Terminated properly, so a reader knows it is finished rather than dropped.
    expect(body).toContain("event: done");
  }, 40_000);

  test("`stepEmit` streams results into their OWN namespace, beside the narration", async () => {
    // The half a mocked `getWritable` cannot reach: whether a namespace really
    // keys a distinct stream in a real world. It has to, or `stepReport()`'s lines
    // and `stepEmit()`'s objects share one channel and a page renders
    // `[object Object]` in the middle of its progress log.
    const started = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({
        workflow: "narrate",
        input: { items: ["one", "two", "three"] },
        wait: 30_000,
      }),
    });
    const runId = started.body.runId as string;

    const narration = await (await fetch(`${origin}/workflows/runs/${runId}/stream`)).text();
    const results = await (
      await fetch(`${origin}/workflows/runs/${runId}/stream?namespace=results`)
    ).text();

    // The default stream carries the SENTENCES and none of the values.
    expect(narration).toContain('event: chunk\ndata: "handling one"');
    expect(narration).toContain('event: chunk\ndata: "handling three"');
    expect(narration).not.toContain("shouted");
    // The named stream carries the VALUES and none of the sentences — typed, so
    // `useWorkflowProgress<T>` has one shape to name.
    expect(results).toContain('"shouted":"ONE"');
    expect(results).toContain('"shouted":"THREE"');
    expect(results).not.toContain("handling");
    // And each is terminated, so a reader knows it finished rather than dropped.
    expect(narration).toContain("event: done");
    expect(results).toContain("event: done");
  }, 40_000);

  test("wake ends a sleeping run early, and reports how many sleeps it stopped", async () => {
    // Started WITHOUT a wait, so the run is parked in its `sleep` when the wake
    // lands. `woken` is the count the route reports — 0 would mean the sleep had
    // already elapsed, which is why this races it deliberately.
    const started = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "research", input: { topic: "kelp beds" } }),
    });
    expect(started.status).toBe(202);
    const runId = started.body.runId as string;

    // Poll until the run is actually asleep — `wake` on a run that has not
    // reached its `sleep` yet has nothing to interrupt, and asserting a count
    // before then would be a race dressed as a finding.
    let lastWakeStatus = 0;
    await vi.waitFor(
      async () => {
        const result = await api(`/workflows/runs/${runId}/wake`, { method: "POST" });
        lastWakeStatus = result.status;
        expect(Number(result.body.woken)).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(lastWakeStatus).toBe(200);
    const finished = await api(`/workflows/runs/${runId}?wait=30000`);
    expect(finished.body).toMatchObject({ status: "completed", output: { topic: "kelp beds" } });
  }, 40_000);

  test("rejects a bad input at the call site, with no run created", async () => {
    const { status, body } = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "research", input: { topic: "" } }),
    });
    expect(status).toBe(400);
    expect(String(body.error)).toContain("topic");
  });

  test("404s a run id nothing knows, rather than waiting the budget out", async () => {
    const started = Date.now();
    const { status } = await api("/workflows/runs/wrun_does_not_exist?wait=30000");
    expect(status).toBe(404);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
