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
import { callbackFlow } from "./workflows/callback.ts";
import { fanOutFlow } from "./workflows/fan-out.ts";
import { secretFlow } from "./workflows/secret.ts";

export const research = workflow({
  description: "Research a topic",
  input: z.object({ topic: z.string() }),
  run: researchFlow,
});

export const callback = workflow({
  description: "Park on a webhook and echo what it delivers",
  input: z.object({ label: z.string().min(1).describe("Echoed back in upper case") }),
  run: callbackFlow,
});

export const fanOut = workflow({
  description: "Fan out over a list in bounded batches",
  input: z.object({ words: z.array(z.string()) }),
  run: fanOutFlow,
});

export const secret = workflow({
  description: "Read the agent env from inside a step",
  input: z.object({}),
  run: secretFlow,
});

export default agent({
  name: "dev-workflow-fixture",
  greeting: "hi",
  systemPrompt: "fixture",
  workflows: { research, callback, fanOut, secret },
  requiredEnv: ["FIXTURE_STEP_TOKEN"],
});
`;

const WORKFLOW_TS = `
import { getWritable, sleep } from "workflow";

export async function researchFlow(input: { topic: string }) {
  "use workflow";
  const findings = await gather(input.topic);
  // The suspension is the point: it is what a tool cannot do, and it is what
  // makes the resume path (a second flow-route call) part of this test.
  await sleep(${JSON.stringify(SLEEP)});
  await file(findings.topic);
  return { topic: findings.topic, sources: findings.sources };
}

async function gather(topic: string) {
  "use step";
  await report("gathering " + topic);
  return { topic, sources: 3 };
}

// A step AFTER the sleep, so the progress assertion covers a stream written
// across a suspension — the run resumes in a fresh flow-route call and has to
// append to the same stream rather than starting a new one.
async function file(topic: string) {
  "use step";
  await report("filed " + topic);
}

// The same best-effort helper both page templates ship. Called from steps only:
// the body replays from the top, so a line written there is re-emitted on every
// resume.
async function report(line: string) {
  try {
    const writer = getWritable().getWriter();
    try {
      await writer.write(line);
    } finally {
      writer.releaseLock();
    }
  } catch {}
}
`;

/**
 * A run that PARKS on a webhook.
 *
 * This is the one thing no unit test can reach: `createWebhook()` throws outside
 * a run, so a spec cannot call a body that opens one. Only a real world, a real
 * queue and a real HTTP delivery exercise it — and no template demonstrates the
 * shape any more (`transcription-workflow` used to, against a stub provider), so
 * this fixture is the only place it is exercised at all.
 *
 * The step delivers its own callback, which makes this a test of the ORDERING as
 * much as of the round trip: `createWebhook()` registers nothing, so without the
 * `getConflict()` claim above it the delivery races a token nothing is listening
 * on yet.
 */
const CALLBACK_TS = `
import { createWebhook } from "workflow";

export async function callbackFlow(input: { label: string }) {
  "use workflow";

  using hook = createWebhook();
  // Claim the token BEFORE the URL is handed out.
  await hook.getConflict();
  await deliver(hook.url, input.label);

  const request = await hook;
  const payload = await request.json();
  // \`hook.url\` is returned so a spec can assert WHERE the DevKit points it. Every
  // reachable path here rests on that answer being guest-local.
  return { label: input.label, echoed: payload.echoed, hookUrl: hook.url };
}

async function deliver(url: string, label: string) {
  "use step";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ echoed: label.toUpperCase() }),
  });
  if (!response.ok) throw new Error("callback delivery failed: " + response.status);
}
`;

/**
 * A fan-out through `mapInBatches` — the SDK primitive `transcription-workflow` maps
 * its segments with.
 *
 * This is the only tier that can say whether that primitive is legal at all.
 * `mapInBatches` passes a `"use step"` function to a helper in ANOTHER MODULE as
 * a callback, and whether that still dispatches a real step depends on what the
 * WDK transform rewrites: a declaration-side rewrite (what `createUseStep`'s
 * shape implies) keeps working through a callback, while a call-site rewrite
 * would leave the step running inline — undurable, unjournaled, and completely
 * silent about it. Reading the transform's output is inference; running one is
 * not.
 *
 * The steps settle in REVERSE issue order, which is the trap the primitive
 * exists for: a pool that issued work as previous calls settled would produce
 * this run's step ids in a different order on a replay.
 */
const FAN_OUT_TS = `
import { mapInBatches } from "@alexkroman1/aai/utils";

export async function fanOutFlow(input: { words: string[] }) {
  "use workflow";
  return { shouted: await mapInBatches(input.words, 2, (word, index) => shout(word, index)) };
}

async function shout(word: string, index: number) {
  "use step";
  // Later items finish FIRST, so completion order is the reverse of issue order.
  await new Promise((resolve) => setTimeout(resolve, (8 - index) * 20));
  return word.toUpperCase();
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
import { requireStepEnv, stepEnv } from "@alexkroman1/aai/utils";

export async function secretFlow() {
  "use workflow";
  return await readSecret();
}

async function readSecret() {
  "use step";
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
  await fs.writeFile(path.join(FIXTURE, "workflows", "callback.ts"), CALLBACK_TS);
  await fs.writeFile(path.join(FIXTURE, "workflows", "fan-out.ts"), FAN_OUT_TS);
  await fs.writeFile(path.join(FIXTURE, "workflows", "secret.ts"), SECRET_TS);
  // The agent env `stepEnv` answers from. `resolveAgentEnv` surfaces DECLARED
  // keys only, so this file is both the declaration and the value.
  await fs.writeFile(path.join(FIXTURE, ".env"), "FIXTURE_STEP_TOKEN=from-dot-env\n");
  await fs.writeFile(
    path.join(FIXTURE, "package.json"),
    JSON.stringify({ name: "dev-workflow-fixture", type: "module", private: true }),
  );
}

/**
 * ONE dev server for the whole file, at module scope rather than inside a
 * `describe` — the HTTP suite below needs the same running server, and a
 * `beforeAll` nested in the first block tears it down before the second starts.
 */
let stop: (() => Promise<void>) | undefined;
let workflowId: string | undefined;
let origin = "";

beforeAll(async () => {
  await writeFixture();
  // A provider key has to be resolvable or `resolveAgentEnv` reaches for the
  // logged-in one; the value is never dialled, since no session is opened.
  process.env.ASSEMBLYAI_API_KEY ??= "not-used-by-this-test";
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

describe("aai dev serves a durable workflow", () => {
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

/**
 * The workflow HTTP API, over the same dev server.
 *
 * This is the only tier that can exercise it end to end. `host/workflow-api.
 * test.ts` drives the routes against a STUB `ctx.workflows`; here every link is
 * real — the CLI's two bundlers, the DevKit transform, the world, the queue, the
 * routes — and the run genuinely parks on a webhook and is brought back by an
 * HTTP delivery. A break anywhere in that chain shows up as a run that never
 * completes, which is invisible to every layer's own suite.
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
      "callback",
      "fanOut",
      "research",
      "secret",
    ]);
    // The zod schema, converted at listing time because the reader is a browser.
    // `<WorkflowFields>` renders one control per property of this.
    expect(workflows.find((w) => w.name === "callback")?.inputSchema).toMatchObject({
      type: "object",
      properties: { label: { description: "Echoed back in upper case" } },
    });
  });

  test("`wait` returns the finished run — a webhook round trip inside one POST", async () => {
    // One request in, one result out. The run parks on a webhook in the middle
    // of that request and is resumed by an HTTP delivery to the agent's own
    // endpoint; `wait` is what turns the whole round trip into a single call.
    const { status, body } = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "callback", input: { label: "otters" }, wait: 30_000 }),
    });

    expect(status).toBe(200);
    expect(body.run).toMatchObject({
      status: "completed",
      output: { label: "otters", echoed: "OTTERS" },
    });
  }, 40_000);

  test("the URL the DevKit mints is GUEST-LOCAL — the premise publicWebhookUrl rests on", async () => {
    // The whole reason `ctx.workflows.publicWebhookUrl` exists, pinned against the
    // real installed DevKit rather than taken on trust. `createWebhook()` composes
    // `hook.url` from `getWorkflowMetadata().url`, which is `http://localhost:<port>`
    // off the running process (its only other branch is `https://$VERCEL_URL`) — so
    // deployed, it names the inside of a sandbox that has self-exited by the time a
    // third party calls back. Only this tier can see it: the mint happens inside the
    // workflow VM, and outside a run `createWebhook()` throws.
    //
    // If this ever fails because the URL grew a public origin, the SDK accessor
    // becomes a supplement to something usable rather than the only usable answer —
    // read the note in `packages/aai/CLAUDE.md` before deleting anything.
    const { body } = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "callback", input: { label: "kelp" }, wait: 30_000 }),
    });
    const output = (body.run as { output: { hookUrl: string } }).output;
    expect(output.hookUrl).toMatch(/^http:\/\/localhost:\d+\//);
    // And the PATH is the one both ends derive from `WORKFLOW_WEBHOOK_PREFIX`, which
    // is what makes composing a public URL out of a token legitimate rather than a
    // guess about someone else's routing.
    expect(output.hookUrl).toContain("/.well-known/workflow/v1/webhook/");
  }, 40_000);

  test("the run id it hands back reads the same run afterwards", async () => {
    const started = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "callback", input: { label: "seals" }, wait: 30_000 }),
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

  test("a bounded fan-out through `mapInBatches` runs its steps for real", async () => {
    // Results in ITEM order although the steps settle in reverse, and — the
    // part no unit test can reach — every one of them dispatched as a genuine
    // step through the transform while being called from an SDK helper rather
    // than from the body's own source. See `FAN_OUT_TS`.
    const { status, body } = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({
        workflow: "fanOut",
        input: { words: ["one", "two", "three", "four", "five"] },
        wait: 30_000,
      }),
    });

    expect(status).toBe(200);
    expect(body.run).toMatchObject({
      status: "completed",
      output: { shouted: ["ONE", "TWO", "THREE", "FOUR", "FIVE"] },
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
    let woken = 0;
    for (let attempt = 0; attempt < 40 && woken === 0; attempt += 1) {
      const result = await api(`/workflows/runs/${runId}/wake`, { method: "POST" });
      expect(result.status).toBe(200);
      woken = Number(result.body.woken);
      if (woken === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(woken).toBeGreaterThan(0);
    const finished = await api(`/workflows/runs/${runId}?wait=30000`);
    expect(finished.body).toMatchObject({ status: "completed", output: { topic: "kelp beds" } });
  }, 40_000);

  test("rejects a bad input at the call site, with no run created", async () => {
    const { status, body } = await api("/workflows/runs", {
      method: "POST",
      headers: JSON_POST,
      body: JSON.stringify({ workflow: "callback", input: { label: "" } }),
    });
    expect(status).toBe(400);
    expect(String(body.error)).toContain("label");
  });

  test("404s a run id nothing knows, rather than waiting the budget out", async () => {
    const started = Date.now();
    const { status } = await api("/workflows/runs/wrun_does_not_exist?wait=30000");
    expect(status).toBe(404);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
