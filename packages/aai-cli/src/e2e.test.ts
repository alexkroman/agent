// Copyright 2025 the AAI authors. MIT license.
/**
 * End-to-end CLI tests: Vite builds, real servers, real durable workflow runs.
 *
 * The Playwright half moved to `e2e-browser.test.ts` when this file reached the
 * 700-line test cap, at the seam this doc already drew.
 *
 * ## The shared setup runs once PER FILE, and that is now safe
 *
 * `buildCli()` and `startRegistry()` mutate state shared across the whole run —
 * `packages/aai-cli/dist`, and workspace package.json versions during publish.
 * This doc used to say the setup "must run exactly once per e2e run — never
 * once per file (vitest runs files concurrently)", which is what made a second
 * file unsafe. The e2e profile now sets `fileParallelism: false`
 * (`vitest.slow.config.ts`, which carries the argument), so the files run one
 * after another and each gets its own build and its own registry at a unique
 * version. Do not reintroduce concurrency here without replacing this setup
 * with a `globalSetup`.
 *
 * Shared helpers live in `_e2e-test-utils.ts`; the provider-free workflow lab
 * the durable cases drive is in `_e2e-workflow-test-utils.ts`.
 *
 * Run via: pnpm test:e2e
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { errorDetail } from "@alexkroman1/aai/utils";
import { ofetch } from "ofetch";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  aai,
  aaiEnv,
  aaiOutputFailing,
  buildCli,
  detachedCli,
  installDeps,
  isRegistryProxyFailure,
  startRegistry,
  startSelfHostedServer,
} from "./_e2e-test-utils.ts";
import {
  cancelRun,
  HOSTILE_TARGETS,
  installWorkflowLab,
  isSleeping,
  readRun,
  startRun,
  waitForRun,
  wakeRun,
} from "./_e2e-workflow-test-utils.ts";
import { startSupervisedDevServer } from "./_fault-mode.ts";
import type { MockRegistry } from "./_mock-registry.ts";
import { WORKER_ARTIFACT_REL } from "./build.ts";

// Representative subset: minimal baseline, external tools + custom UI, and
// durable workflows. This tier only builds these end-to-end. Config-level
// validation of EVERY template (asset imports resolve, toAgentConfig accepts
// the config) lives in packages/aai-templates/src/templates.test.ts
// (pnpm test:templates).
//
// `research-workflow` is here for one reason no in-tree test can cover: its
// `workflows/research.ts` imports `workflow`, and a scaffolded project resolves
// its dependencies from a real INSTALL of the published manifest rather than
// from this repo's node_modules. Missing from the scaffold's `dependencies`,
// the package resolves in every repo test and in nothing a user runs — the
// build dies on `Could not resolve "workflow"` in the one place no CI job
// looks.
//
// `link-digest` is the WORKFLOW APP — `workflowApp()` + `mountPage()`, no
// stt/llm/tts, `page: "static"`. It is a different front door with different
// wiring (telephony defaults off, `/websocket` is declined with a reason), and
// until it was added no workflow app was built or booted anywhere in this tier;
// the shipped set has six of them.
const templates = ["simple", "web-researcher", "research-workflow", "link-digest"];

let aaiBin: string;
let tmpDir: string;
let registry: MockRegistry;

beforeAll(async () => {
  aaiBin = buildCli();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-e2e-test-"));
  // Start mock npm registry and publish workspace packages to it.
  // Packages are built + published inside startMockRegistry, so consumers
  // (npm/pnpm/yarn install) resolve them exactly as they would from the real registry.
  registry = await startRegistry();
});

afterAll(async () => {
  await registry?.stop();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Pack + build: representative templates ---

describe("pack + build + boot: template workflows", () => {
  test.concurrent.for(templates)("template %s", async (template, ctx) => {
    const projectDir = path.join(tmpDir, template);

    // Init + install from mock registry + test + build
    aai(aaiBin, ["init", projectDir, "-t", template], tmpDir);
    try {
      installDeps(registry, projectDir);
    } catch (err) {
      // The mock registry's proxy to npmjs can fail in restricted
      // environments (e.g. turbo CI with egress proxies). Skip VISIBLY —
      // a silent `return` made the whole suite a green no-op exactly where
      // registry/exports regressions would surface — and only for failures
      // that look like network/proxy trouble; a real dependency-resolution
      // bug in the published packages must still fail.
      if (!isRegistryProxyFailure(err)) throw err;
      // Also log the full failure — the skip note is truncated and the
      // install output is captured, so this is the only diagnosis trail.
      const detail = errorDetail(err);
      const output = (err as { stderr?: string; stdout?: string }) ?? {};
      console.warn(
        `[e2e] install skipped for template ${template}:\n${detail}\n` +
          `stderr:\n${output.stderr ?? ""}\nstdout:\n${output.stdout ?? ""}`,
      );
      ctx.skip(`pnpm install failed (registry proxy issue): ${String(err).slice(0, 200)}`);
    }
    aai(aaiBin, ["test"], projectDir);
    aai(aaiBin, ["build", "--skip-tests"], projectDir);

    // `aai` only signals a successful build by not throwing — so name the
    // artifact instead. `WORKER_ARTIFACT_REL` is what the scaffold's `server.mjs`
    // loads, which is the difference between a build that exited 0 and a project
    // that runs.
    expect(fs.existsSync(path.join(projectDir, WORKER_ARTIFACT_REL))).toBe(true);

    // And then BOOT it, which is the step this test used to stop one short of —
    // the comment above gestured at `server.mjs` loading that artifact and
    // nothing checked that it could. Cheap here because the install is already
    // paid for, and it takes self-hosted boot coverage from the two templates the
    // dedicated legs below use to every template in this subset. `/health` is the
    // whole assertion: a workflow app and a voice agent answer it identically, so
    // it is the one claim that holds across the front doors without asserting a
    // shape that differs by template.
    const server = await startSelfHostedServer(projectDir);
    try {
      const health = await ofetch<{ status: string }>(`${server.url}/health`);
      expect(health.status).toBe("ok");
    } catch (err) {
      throw new Error(
        `${errorDetail(err)}\n--- npm start output ---\n${server.output().slice(-4000)}`,
        { cause: err },
      );
    } finally {
      await server.stop();
    }
  });
});

describe("self-hosted server: npm start", () => {
  /**
   * The scaffold ships `server.mjs` and the `prestart`/`start` pair, so every
   * project runs on its own with `npm start`. Only this tier can prove it: the
   * project's own `aai build` runs from a real INSTALL, `server.mjs` imports the
   * worker that build left on disk, and `defaultClientDir()` resolves out of the
   * installed `@alexkroman1/aai-ui`.
   *
   * **`pizza-ordering`, because it has a `tools/` directory — which is what this
   * leg is really about.** A tool is registered by EXISTING, enumerated into the
   * bundler's generated entry, so an entrypoint loading `agent.ts` directly boots
   * an agent with none of its six tools and no error anywhere. It also keeps what
   * `math-buddy` was picked for: a `./system-prompt.md?raw` import.
   */
  test("boots a scaffolded pizza-ordering project and serves it", async ({ skip }) => {
    const projectDir = path.join(tmpDir, "_self-hosted");
    aai(aaiBin, ["init", projectDir, "-t", "pizza-ordering"], tmpDir);
    try {
      installDeps(registry, projectDir);
    } catch (err) {
      if (!isRegistryProxyFailure(err)) throw err;
      skip(`pnpm install failed (registry proxy issue): ${String(err).slice(0, 200)}`);
    }

    // No --skip-* anything: `npm start` runs the project's own `prestart`, which
    // is the half of self-hosting under test. The spawn itself is
    // `startSelfHostedServer` — shared with the durable-workflow leg below, so the
    // two cannot drift on how a port is read or how a boot failure is reported.
    const server = await startSelfHostedServer(projectDir);
    const port = server.port;
    try {
      const health = await ofetch<{ status: string; name: string }>(
        `http://127.0.0.1:${port}/health`,
      );
      expect(health).toMatchObject({ status: "ok", name: "Pizza Palace" });

      // The greeting proves createAgentServer read it off the agent rather
      // than the caller restating it — the silent-drop bug that command exists
      // to prevent. The page proves defaultClientDir() resolved from the
      // installed package, which no in-tree test can check.
      const config = await ofetch<{ name: string; greeting?: string }>(
        `http://127.0.0.1:${port}/client-config`,
      );
      expect(config.greeting).toBeTruthy();
      expect(await ofetch(`http://127.0.0.1:${port}/`, { responseType: "text" })).toContain(
        "<!DOCTYPE html>",
      );

      // The tools, read out of the artifact the server booted — nothing over
      // HTTP exposes a tool list, and this is the assertion that matters: these
      // six names exist ONLY because the build enumerated `tools/`, and the
      // failure is otherwise silent (every probe above still passes).
      const worker = path.join(projectDir, ".aai", "worker.mjs");
      const { __aaiConfig } = (await import(pathToFileURL(worker).href)) as {
        __aaiConfig: { toolSchemas: { name: string }[] };
      };
      const names = __aaiConfig.toolSchemas.map((t) => t.name);
      // Code-unit sort, never localeCompare — the standing rule here.
      expect(names.sort((a, b) => Number(a > b) - Number(a < b))).toEqual([
        "add_pizza",
        "place_order",
        "remove_pizza",
        "set_customer_name",
        "update_pizza",
        "view_order",
      ]);
    } finally {
      await server.stop();
    }
  });
});

describe("self-hosted server: durable workflows", () => {
  /**
   * "Can a user `aai init` a workflow template and run something DURABLE under
   * `npm start`" — and until this test existed, no.
   *
   * The gap it closes was structural rather than a bug in one line. Under the
   * DevKit, running a durable workflow took two things the self-hosted door
   * never did: a WORLD (`configureWorkflowWorld` + `startWorkflowWorldIfDeclared`,
   * which nothing but `aai dev` and the guest harness called) and the `flow`/
   * `step` callback routes the world dispatched every hop to. The replay engine
   * needs neither — `createRuntime` builds it off the agent's own `workflows`
   * declaration and walks a run in this process — so what this leg now proves is
   * that the door a self-hoster goes through gets one at all.
   *
   * Nothing else can ask this. The `aai dev` leg below drives the same lab
   * through a different front door, and the "boots and serves it" leg above uses
   * `pizza-ordering`, which declares no workflows at all — so a self-hosted
   * server that accepted a run and then stalled forever passed every test in the
   * repo.
   */
  test("runs a durable workflow end to end under npm start", async ({ skip }) => {
    const projectDir = path.join(tmpDir, "_self-hosted-workflow");
    aai(aaiBin, ["init", projectDir, "-t", "research-workflow"], tmpDir);
    try {
      installDeps(registry, projectDir);
    } catch (err) {
      if (!isRegistryProxyFailure(err)) throw err;
      skip(`pnpm install failed (registry proxy issue): ${String(err).slice(0, 200)}`);
    }
    // The same provider-free lab the `aai dev` leg uses: `labCount` is steps and
    // arithmetic, so a completed run says the queue and the step callbacks work
    // without any provider being reachable.
    installWorkflowLab(projectDir);

    const server = await startSelfHostedServer(projectDir);
    try {
      // The PLATFORM's delivery door, which replaced the DevKit's `flow` and
      // `step` callbacks. Unmounted it 404s and the request falls through — which
      // is exactly how this door behaved before it was wired — so anything BUT
      // 404 means the route is mounted.
      //
      // 401 is the RIGHT answer here and not a disappointment: a self-hosted
      // server supplies no `allowRemote`, having no queue outside its own
      // process, so it refuses a caller it cannot vouch for. The run below is
      // what proves the engine actually works; this proves the route exists.
      const delivery = await fetch(`${server.url}/workflow-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(delivery.status).toBe(401);

      // And the run itself, which is the whole point: started through the public
      // API and polled to a terminal status, the way a `curl` script would.
      const runId = await startRun(server.url, "labCount", { steps: 3 });
      const done = await waitForRun(server.url, runId);
      // `{ total }`, which is what `labCountFlow` returns — the shape matters:
      // the output travelled back through the journal, so asserting it (rather
      // than only the status) is what says the run's RESULT survived the hops.
      expect(done).toMatchObject({ status: "completed", output: { total: 3 } });
    } catch (err) {
      // The server's own stdout/stderr carries the reason a run stalled — a world
      // that would not start reports there and nowhere else.
      throw new Error(
        `${errorDetail(err)}\n--- npm start output ---\n${server.output().slice(-4000)}`,
        { cause: err },
      );
    } finally {
      await server.stop();
    }
  });
});

describe("aai dev: a scaffolded workflow template", () => {
  /**
   * "Can a user `aai init` a workflow template, `aai dev` it, and RUN something
   * durable" — and nothing else in the repo can ask it: the in-tree scenario
   * test drives the same code against a fixture resolving `workflow` from this
   * workspace, and the `npm start` leg above has no bundler. Only here is the
   * project scaffolded, installed from the published manifest, and served by
   * the real `aai dev`.
   *
   * A provider-free LAB is spliced in beside the template's own workflow —
   * `_e2e-workflow-test-utils.ts` carries the argument for it, and for what
   * each case below can and cannot prove without a database. One project and
   * one server for the whole describe: installing is what costs minutes here.
   */
  let server: Awaited<ReturnType<typeof startSupervisedDevServer>> | undefined;
  let skipReason: string | undefined;

  beforeAll(async () => {
    const projectDir = path.join(tmpDir, "_dev-workflow");
    aai(aaiBin, ["init", projectDir, "-t", "research-workflow"], tmpDir);
    try {
      installDeps(registry, projectDir);
    } catch (err) {
      // A hook has no `skip`, so the reason is recorded and every case below
      // skips itself on it — the same environment escape the single test had.
      if (!isRegistryProxyFailure(err)) throw err;
      skipReason = `pnpm install failed (registry proxy issue): ${String(err).slice(0, 200)}`;
      return;
    }
    installWorkflowLab(projectDir);
    // `.env`, not the process env: that is where an agent's own configuration
    // is read from, and a value exported in the shell reaches the provider
    // stages but NOT the workflow / session-state layer.
    fs.appendFileSync(path.join(projectDir, ".env"), "\nAAI_SESSION_EVENTS_TOKEN=e2e-events\n");
    server = await startSupervisedDevServer({
      aaiBin,
      cwd: projectDir,
      // Fixed, because `aai dev --port` is how a user picks one and it has to
      // survive a restart; high enough to clear the other servers here.
      port: 4820,
      env: { ...aaiEnv(), ASSEMBLYAI_API_KEY: "e2e-not-dialled" },
      args: ["--json"],
    });
  });

  afterAll(async () => {
    await server?.stop();
  });

  /**
   * The running server, after every declared fault point has fired — under a
   * profile the process is killed and replaced, so a request made without this
   * races the restart window and fails for something that is not a bug.
   */
  async function settled(skip: (note?: string) => never): Promise<string> {
    if (skipReason !== undefined) skip(skipReason);
    if (!server) skip("dev server did not start");
    await server.awaitSettled();
    return server.url;
  }

  test("boots and mounts the platform's delivery door", async ({ skip }) => {
    // Booting at all is most of it. The door replaced the DevKit's `flow` and
    // `step` callbacks; unmounted it 404s and the request falls through.
    //
    // 401 rather than 200 because `aai dev` supplies no `allowRemote` — its
    // engine dispatches on a `setTimeout` in this process, so there is no queue
    // outside it and no caller to vouch for. That the route ANSWERS is the
    // claim; the two cases below are what prove runs actually advance.
    const res = await fetch(`${await settled(skip)}/workflow-queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("a run reaches a terminal status, and its sleep is REALLY taken", async ({ skip }) => {
    // A `sleep` recorded rather than taken passes every in-memory harness (the
    // eval engine records them by design) and answers instantly here.
    const url = await settled(skip);
    const run = await waitForRun(url, await startRun(url, "labSleep", { seconds: 3 }));
    expect(run.status).toBe("completed");
    // The run's own journaled clock, not the test's. Generous: a queue is involved.
    expect((run.output as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(2500);
  });

  test("wakeUp interrupts a pending sleep and reports that it did", async ({ skip }) => {
    // Its answer is a COUNT, and the eval engine answers 0 for every call — so
    // a regression to 0 is invisible in every tier below this one.
    const url = await settled(skip);
    const runId = await startRun(url, "labSleep", { seconds: 300 });
    // Wait for the run to be IN the sleep, not merely picked up: `running` is
    // true from the moment a worker takes it, which is while it is still in the
    // step before the sleep — waking then interrupts nothing and answers 0.
    await vi.waitFor(() => expect(isSleeping(server?.lines() ?? [], 300)).toBe(true), {
      timeout: 60_000,
      interval: 250,
    });
    expect(await wakeRun(url, runId)).toBeGreaterThan(0);
    // The half a count cannot say: the 300s sleep really is over.
    expect((await waitForRun(url, runId)).status).toBe("completed");
  });

  test("cancel answers TRUE only for the call that ended the run", async ({ skip }) => {
    // Documented as "true when this call is what ended it, false when it was
    // already terminal (or no such run exists)". Two of the four shipped wrong:
    // an already-cancelled run said `true` on every world, and a MISSING one
    // said `true` on the LOCAL world — which is the world this tier runs, and
    // the one that hid it while Postgres got it right.
    const url = await settled(skip);
    const live = await startRun(url, "labCount", { steps: 60 });
    await vi.waitFor(async () => expect((await readRun(url, live)).status).toBe("running"), {
      timeout: 30_000,
      interval: 250,
    });
    expect(await cancelRun(url, live)).toBe(true);
    expect(await cancelRun(url, live)).toBe(false);
    expect((await readRun(url, live)).status).toBe("cancelled");

    const done = await startRun(url, "labSleep", { seconds: 1 });
    expect((await waitForRun(url, done)).status).toBe("completed");
    expect(await cancelRun(url, done)).toBe(false);
    expect(await cancelRun(url, "wrun_e2e_never_started")).toBe(false);
  });

  // **There is no webhook test any more.** It parked a run on `createWebhook()`
  // and delivered the callback the way a payment provider would — the only tier
  // that ever could. The engine's waitpoint is `ctx.waitFor`, ended by
  // `ctx.workflows.signal`, and `/.well-known/workflow/v1/webhook/:token` still
  // routes to the DevKit's hook table, which knows nothing about the journal. So
  // this covers webhooks with nothing, deliberately: see the note in
  // `dev-workflow.scenario.test.ts` for what closes it.

  test("`aai test` FAILS naming the spec files it did not run", async ({ skip }) => {
    // The lab leaves a spec `aai test` does not run and no `agent.test.ts`, so
    // this drives the arm that stayed broken longest: the CLI printed "No test
    // file found. Create agent.test.ts to add tests." while the project's specs
    // sat right there unrun. Only a scaffolded project can observe it — the
    // rule is about a real directory, not about a function's arguments.
    //
    // Naming them was never enough: the exit code is what CI reads, and this
    // arm returned 0. So the assertion is the code FIRST and the message
    // second — a version that only greps stdout passed throughout the years
    // this was green over an unrun suite.
    if (skipReason !== undefined) skip(skipReason);
    const { stdout, stderr, exitCode } = aaiOutputFailing(
      aaiBin,
      ["test"],
      path.join(tmpDir, "_dev-workflow"),
    );
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain("lab.test.ts");
  });

  test("a caller cannot make a bad request target answer 5xx", async ({ skip }) => {
    // Two shipped bugs had this shape — a path segment or query value reaching
    // a store unvalidated and coming back 500 for a plainly bad request. A unit
    // test BUILDS the id it passes, so only a real server on a real port has a
    // raw request target at all. `HOSTILE_TARGETS` records which entries were
    // measured to fail without their fix HERE, and which need a database.
    // `expect.soft` with the target as its label, so one run names every
    // offender rather than stopping at the first.
    const url = await settled(skip);
    for (const target of HOSTILE_TARGETS) {
      const res = await fetch(`${url}${target}`);
      expect.soft(res.status, target).toBeLessThan(500);
    }
  });
});

describe("bundled templates", () => {
  // `aai init` used to giget the templates from GitHub at run time; they now
  // ship inside dist/. Nothing in-tree can catch a regression here, because a
  // CLI running from packages/aai-cli/dist always finds the workspace root and
  // takes the monorepo branch — so detach the build first.
  test("init works from a detached dist with no workspace above it", () => {
    const detachedDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-detached-"));
    try {
      const detachedBin = detachedCli(aaiBin, detachedDir);
      const projectDir = path.join(tmpDir, "bundled-templates");
      aai(detachedBin, ["init", projectDir, "-t", "pipeline-simple"], tmpDir);

      // A template file and a scaffold file: both dirs have to ship.
      expect(fs.existsSync(path.join(projectDir, "agent.ts"))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, "tsconfig.json"))).toBe(true);
    } finally {
      fs.rmSync(detachedDir, { recursive: true, force: true });
    }
  });
});
