// Copyright 2026 the AAI authors. MIT license.
/**
 * A provider-free workflow LAB for the e2e tier, and the HTTP verbs to drive it.
 *
 * ## Why a lab rather than the shipped template's own workflows
 *
 * The e2e workflow test could only ever assert that the DevKit's queue routes
 * were MOUNTED (`status !== 404`), because `research-workflow`'s one workflow
 * calls a model and a search engine on the first step — so an e2e run with no
 * credentials cannot drive it past `running`, and one WITH credentials would
 * make a required check paid and flaky. The whole durable lifecycle therefore
 * sat uncovered at this tier: a run reaching a terminal status, `sleep()` being
 * really taken, `wakeUp` shortening it, `cancel`'s four answers, a webhook
 * resuming a parked run.
 *
 * Every one of those is reachable with workflows that call NO provider, which
 * is what these are. They are written INTO the scaffolded project after
 * `aai init`, so they take the same path as the template's own — the CLI's
 * worker bundle, the SDK installed from the published manifest, and the engine
 * that bundle's own runtime builds. That path is the reason this tier exists.
 * (It used to run through the DevKit's swc transform and its separate flow and
 * step bundles as well; those are gone, and what is left is the path a user's
 * project actually takes.)
 *
 * ## What is deliberately NOT here
 *
 * A DATABASE. `aai dev` with no `DATABASE_URL` journals runs IN MEMORY, and
 * every assertion below was measured against that before being written, because
 * the two journals do diverge — a missing run answered `cancel` differently on
 * each, which is a bug this file's `cancel` case now pins. Anything that needs
 * Postgres (`aai_session_events`, the bigint-column input bugs) belongs to the
 * scenario tier's `describeWithPg`, not here, and {@link HOSTILE_TARGETS} says
 * so where it matters.
 */

import fs from "node:fs";
import path from "node:path";
import { sleep } from "@alexkroman1/aai/internal";
import { ofetch } from "ofetch";

/**
 * The lab's bodies — two flows and two steps, no provider.
 *
 * Under `workflows/` because that is where an author puts them and where the
 * scaffold's tooling looks; nothing about the directory is load-bearing to the
 * engine any more, which reads a body off `agent({ workflows })`.
 *
 * **There is no webhook flow.** It parked on `createWebhook()` and was resumed
 * by an HTTP delivery. It was dropped while the engine's equivalent —
 * `ctx.waitFor(token)`, ended by `ctx.workflows.signal` — had no route in front
 * of it; `createRuntimeServer` mounts one now (`workflow-webhook.ts`), so the case is
 * writable again. See `dev-workflow.scenario.test.ts` for the same hole stated
 * at length.
 */
const LAB_FLOWS_TS = `// Written by the e2e suite — a provider-free workflow lab.
import type { WorkflowCtx } from "@alexkroman1/aai";
import { stepReport } from "@alexkroman1/aai/step";

export async function labSleepFlow(input: { seconds: number }, ctx: WorkflowCtx) {
  // Stamped by a STEP either side, so the elapsed time is journaled rather than
  // read off a body that replays: a resumed run recomputes the body from the
  // top, and a bare Date.now() there would restamp on every replay.
  const before = await ctx.step("labNowBefore", () => labNow());
  // Reported IMMEDIATELY before the sleep, and it is load-bearing for the
  // wakeUp case: a run is \`running\` from the moment it is picked up, which is
  // while it is still in the step above and has no pending sleep to interrupt.
  // Waiting on status alone therefore raced, and \`wakeUp\` answered 0 — a
  // green-looking assertion about nothing. This line is the only signal that
  // the sleep is actually registered.
  stepReport(\`lab-sleeping \${input.seconds}\`);
  await ctx.sleep("labSleep", input.seconds * 1000);
  const after = await ctx.step("labNowAfter", () => labNow());
  return { before, after, elapsedMs: after - before };
}

export async function labCountFlow(input: { steps: number }, ctx: WorkflowCtx) {
  let total = 0;
  for (let i = 0; i < input.steps; i += 1) {
    total = await ctx.step("labInc", () => labInc(total));
    stepReport(\`lab-count \${total}\`);
    await ctx.sleep("labTick", 1000);
  }
  return { total };
}

export async function labNow(): Promise<number> {
  return Date.now();
}

export async function labInc(n: number): Promise<number> {
  return n + 1;
}
`;

/**
 * A spec `aai test` will NOT run, and must SAY it did not run.
 *
 * `aai test` runs `agent.test.ts` and nothing else, which is correct — and used
 * to be silent about it, in two arms. With an `agent.test.ts` present it
 * reported "Tests passed" and named nothing: the shipped `retail` template
 * carries seven sibling specs, so that run left 211 of the project's 278 tests
 * unexecuted. With NO `agent.test.ts` it printed "No test file found. Create
 * agent.test.ts to add tests." while the project's specs sat right there —
 * which reads as "this project has no tests", and is the arm this fixture
 * drives (see {@link installWorkflowLab}, which removes the template's own).
 *
 * A scaffolded project is the only place either is observable: the rule is
 * about a real directory, not about a function's arguments.
 */
const LAB_SPEC_TS = `// Written by the e2e suite — a sibling spec \`aai test\` does not run.
import { expect, test } from "vitest";
import { labSleep } from "./lab.ts";

test("the lab declares a sleeper", () => {
  expect(labSleep.description).toContain("Sleep");
});
`;

/** The declarations `agent.ts` names, kept out of `workflows/` like every template's. */
const LAB_DECL_TS = `// Written by the e2e suite — declarations for the workflow lab.
import { workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { labCountFlow, labSleepFlow } from "./workflows/lab.ts";

export const labSleep = workflow({
  description: "Sleep for N seconds and report the wall clock either side",
  input: z.object({ seconds: z.number() }),
  run: labSleepFlow,
});

export const labCount = workflow({
  description: "Count to N, one journaled step and one durable sleep per tick",
  input: z.object({ steps: z.number() }),
  run: labCountFlow,
});
`;

/**
 * The line in a template's `agent.ts` the lab is spliced into.
 *
 * An anchored replace rather than a rewrite of the file: the template's own
 * workflow stays declared, so the original "does a scaffolded workflow template
 * build and boot" assertion is unchanged and the lab rides alongside it. If a
 * template ever stops spelling this line exactly, {@link installWorkflowLab}
 * throws naming it rather than silently installing nothing.
 */
const WORKFLOWS_ANCHOR = "  workflows: { research },";

/** Add the lab to an already-scaffolded project, in place. */
export function installWorkflowLab(projectDir: string): void {
  fs.mkdirSync(path.join(projectDir, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "workflows", "lab.ts"), LAB_FLOWS_TS);
  fs.writeFileSync(path.join(projectDir, "lab.ts"), LAB_DECL_TS);
  fs.writeFileSync(path.join(projectDir, "lab.test.ts"), LAB_SPEC_TS);

  // The template's own spec asserts the EXACT workflow list its `agent.ts`
  // declares, so splicing the lab in breaks it — correctly, and the e2e run is
  // what said so. It is removed rather than edited around: this project is a
  // lab now, and the template's spec is already run against a pristine copy by
  // the "pack + build" describe, which is where that claim belongs. Removing it
  // also puts `aai test` on its NO-agent.test.ts arm, which is the half of the
  // unrun-spec reporting that shipped broken for longer.
  fs.rmSync(path.join(projectDir, "agent.test.ts"), { force: true });

  const agentPath = path.join(projectDir, "agent.ts");
  const agent = fs.readFileSync(agentPath, "utf8");
  if (!agent.includes(WORKFLOWS_ANCHOR)) {
    throw new Error(
      `e2e workflow lab: agent.ts no longer contains ${JSON.stringify(WORKFLOWS_ANCHOR)}. ` +
        "The template changed shape — re-point the anchor rather than dropping the lab, " +
        "or the lifecycle tests silently assert nothing.",
    );
  }
  fs.writeFileSync(
    agentPath,
    `import { labCount, labSleep } from "./lab.ts";\n${agent}`.replace(
      WORKFLOWS_ANCHOR,
      "  workflows: { research, labSleep, labCount },",
    ),
  );
}

/** One run, as the read routes report it. */
export type RunSnapshot = {
  runId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  output?: unknown;
  error?: string;
};

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** How often {@link waitForRun} re-reads. A queue is involved; sub-second is pointless. */
const POLL_INTERVAL_MS = 250;

/** `POST /workflows/runs` — start a run, answer its id. */
export async function startRun(url: string, workflow: string, input: unknown): Promise<string> {
  const body = await ofetch<{ runId: string }>(`${url}/workflows/runs`, {
    method: "POST",
    body: { workflow, input },
  });
  return body.runId;
}

/** `GET /workflows/runs/:id`. */
export function readRun(url: string, runId: string): Promise<RunSnapshot> {
  return ofetch<RunSnapshot>(`${url}/workflows/runs/${runId}`);
}

/**
 * Poll one run until it is terminal.
 *
 * A poll rather than the SSE stream deliberately: this tier's subject is the
 * RUN reaching a terminal status, and reading it the way a `curl` script would
 * keeps a stream bug from being reported as a lifecycle failure. The SSE
 * surface has its own coverage in `workflow-api-events.test.ts`.
 */
export async function waitForRun(
  url: string,
  runId: string,
  timeoutMs = 90_000,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: RunSnapshot | undefined;
  while (Date.now() < deadline) {
    last = await readRun(url, runId);
    if (TERMINAL.has(last.status)) return last;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `run ${runId} never reached a terminal status within ${timeoutMs}ms ` +
      `(last: ${last?.status ?? "unread"})`,
  );
}

/** `DELETE /workflows/runs/:id` — resolves what the route reported. */
export async function cancelRun(url: string, runId: string): Promise<boolean> {
  const body = await ofetch<{ cancelled: boolean }>(`${url}/workflows/runs/${runId}`, {
    method: "DELETE",
  });
  return body.cancelled;
}

/** `POST /workflows/runs/:id/wake` — resolves how many sleeps were interrupted. */
export async function wakeRun(url: string, runId: string): Promise<number> {
  const body = await ofetch<{ woken: number }>(`${url}/workflows/runs/${runId}/wake`, {
    method: "POST",
  });
  return body.woken;
}

/**
 * Has a `labSleep` run reached its `sleep` — as opposed to merely being picked
 * up?
 *
 * The distinction the `wakeUp` case rests on: `running` is true from the moment
 * a worker takes the run, which is while it is still in the step BEFORE the
 * sleep, so waking then interrupts nothing and answers 0.
 */
export function isSleeping(lines: readonly string[], seconds: number): boolean {
  return lines.some((line) => line.includes(`lab-sleeping ${seconds}`));
}

/**
 * Request targets a caller can send that must never be answered `5xx`.
 *
 * Two shipped bugs had exactly this shape — a path segment or a query value
 * reaching a store unvalidated and coming back as `500 Internal server error`
 * for what is plainly a bad request. Both were found by hand against a running
 * server and neither was reachable from any suite, because a unit test builds
 * the id it passes and a scaffolded server is the only place a raw request
 * target exists.
 *
 * **What this list can and cannot catch, measured rather than assumed.** With
 * the NUL guard reverted, `GET`/`DELETE /workflows/runs/wrun_%00` answered 500
 * on the LOCAL world — so those two entries really do fail without the fix, at
 * this tier, with no database. The session-events NUL and the out-of-range
 * `startIndex` only ever 500'd against POSTGRES (the memory backend takes any
 * string and any number), so they are here as a cheap regression net and NOT as
 * proof of that surface; the tier that can prove it is the scenario one's
 * `describeWithPg`.
 */
export const HOSTILE_TARGETS: readonly string[] = [
  // A NUL is the escape that DECODES and is still not a path segment, so it
  // walks past a malformed-escape guard and into whatever the segment addresses.
  "/workflows/runs/wrun_%00",
  "/workflows/runs/wrun_%00/events",
  // Malformed escapes, which throw in the decoder rather than decoding.
  "/workflows/runs/%",
  "/workflows/runs/%zz",
  "/workflows/runs/%C0%80",
  "/workflows/runs/%A/wake",
  // Decodes to something legal-LOOKING and addresses nothing. This entry found
  // a real bug on its first e2e run: the file-backed local world refuses the id
  // itself (no traversal) but does it by throwing, so the router answered 500.
  // Postgres has no such rule and simply 404s, which is what hid it.
  "/workflows/runs/wrun_%2E%2E%2Fetc",
  "/workflows/runs/wrun_a%2Fb",
  // Upload ids, whose own grammar check is the reason they escaped both bugs —
  // included so a regression that removes it is visible here too.
  "/workflows/uploads/bad..id",
  "/workflows/uploads/bad..id/info",
  // Query values reaching a typed column or a parser.
  "/workflows/runs?workflow=labSleep&limit=abc",
  "/workflows/runs?workflow=labSleep&limit=-1",
  "/workflows/runs?workflow=%00",
  "/workflows/runs",
];
