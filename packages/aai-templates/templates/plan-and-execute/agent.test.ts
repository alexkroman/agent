/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type { ToolContext } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDialogOk,
  runGuardrail,
  type ScriptedToolContext,
  type StubDelegateRoute,
  type StubGenerateRoute,
  scriptedToolContext,
  stubDelegate,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { visitWebpage, webSearch } from "@alexkroman1/aai/tools";
import { describe, expect, test, vi } from "vitest";

import { executeStep, executor, MAX_STEP_TURNS, normalizeAct, planNode } from "./procedure.ts";
import { PLANNER_SYSTEM, REPLANNER_SYSTEM, REVISE_SYSTEM, type StepAnswer } from "./prompts.ts";
import {
  MAX_PAGE_CHARS,
  MAX_PAST_STEPS,
  MAX_REVISIONS,
  planFlow,
  planProjection,
  planSlot,
  planView,
  readTool,
  searchTool,
} from "./shared.ts";

/**
 * The web, faked at the SDK's own seam.
 *
 * `webSearch` screens a URL and then really fetches it, through an undici
 * dispatcher a `globalThis.fetch` stub cannot reach — so mocking the module is
 * the only honest way to keep this suite offline. The EXECUTOR's own tests need
 * none of it: they stub the delegation, which is the seam a subagent is reached
 * through.
 */
vi.mock("@alexkroman1/aai/tools", () => ({ webSearch: vi.fn(), visitWebpage: vi.fn() }));

// ─── A scripted desk ─────────────────────────────────────────────────────────
//
// TWO fakes, because the desk reaches a model two ways. The planner and the
// replanner are `ctx.generate` calls carrying their own system prompt, so the
// `generate` script — keyed by system prompt — drives them; the EXECUTOR is a
// subagent, so the `delegate` script drives it, routed by subagent name. That
// split is the conversion showing through in the test file, and it is the
// honest one: a spec that scripted the executor's turns was scripting a loop
// this template no longer owns. `scriptedToolContext` builds both fakes and
// the context they are wired into, so every test below starts from one call.

interface Script {
  steps?: string[];
  /** One entry per executed step: what the executor concluded. */
  answers?: (string | StepAnswer)[];
  /** Searches to report on each executed step, as the run's tool calls. */
  searches?: string[];
  /** One entry per replan/revise call. */
  acts?: { kind: "respond" | "plan"; response?: string; steps?: string[] }[];
}

/**
 * One executor run's final message.
 *
 * The executor declares a `schema`, so its reply really is JSON on the wire and
 * `stubDelegate` really parses it against that schema — a script that drifted
 * from the shape fails HERE naming the subagent, rather than handing
 * `executeStep` an `object` it never had. A bare string is the settled case,
 * which is what most of these tests want to say.
 */
function stepReply(answer: string | StepAnswer): string {
  return JSON.stringify(typeof answer === "string" ? { finding: answer, settled: true } : answer);
}

function scriptedDesk(script: Script = {}): ScriptedToolContext {
  const answers = [...(script.answers ?? [])];
  const acts = [...(script.acts ?? [])];
  // The replanner and the reviser are the same node with a different brief, so
  // they share one queue — which is what the "revise then carry on" test rests on.
  // Annotated as the SDK's own route type: a route is a reply or a function of
  // the call, and naming it is what keeps this queue honest about being the
  // second form rather than a value computed once.
  const act: StubGenerateRoute = () => ({
    object: acts.shift() ?? { kind: "respond", response: "All done." },
  });
  const worksTheStep: StubDelegateRoute = () => ({
    text: stepReply(answers.shift() ?? "Settled it."),
    toolCalls: (script.searches ?? []).map((query) => ({ name: "search", input: { query } })),
  });

  return scriptedToolContext({
    generate: {
      [PLANNER_SYSTEM]: { object: { steps: script.steps ?? ["Only step"] } },
      [REPLANNER_SYSTEM]: act,
      [REVISE_SYSTEM]: act,
    },
    delegate: { executor: worksTheStep },
  });
}

/** A tool by the name the model calls it by, bound to this agent. The lookup,
 *  its "no such tool" message and the args-or-context shape are all
 *  `toolRunner`'s (`@alexkroman1/aai/testing`); what is local is only which
 *  agent it runs against. */
const run = toolRunner(agentDef);

function stateOf(ctx: ToolContext) {
  return planSlot.get(ctx);
}

// ─── 1. The nodes ────────────────────────────────────────────────────────────

describe("planNode", () => {
  test("returns the steps the planner produced", async () => {
    const { model } = scriptedDesk({ steps: ["Check prices", "Book it"] });
    expect(await planNode(model.generate, "get me to Lisbon in May")).toEqual([
      "Check prices",
      "Book it",
    ]);
    expect(model.calls[0]?.prompt).toContain("get me to Lisbon in May");
  });
});

describe("executeStep", () => {
  test("hands the step to the executor, with the objective and the history as context", async () => {
    const desk = stubDelegate({ executor: stepReply("Flights are around 180 return.") });

    const outcome = await executeStep(desk.delegate, "get to Lisbon", "Check prices", [
      { step: "Pick dates", result: "Mid-May", settled: true, searches: [] },
    ]);

    // `finding` off the schema's own output, not the raw final message: the
    // executor is a TYPED subagent, so what crosses back is a parsed object.
    expect(outcome.result).toBe("Flights are around 180 return.");
    expect(outcome.settled).toBe(true);
    // The STEP is the task; everything the executor needs to do it in context
    // rides in `context`, because a subagent has not heard the call.
    expect(desk.calls[0]?.task).toBe("Check prices");
    expect(desk.calls[0]?.options.context).toContain("get to Lisbon");
    expect(desk.calls[0]?.options.context).toContain("Mid-May");
  });

  test("reports what it searched, read off the calls the run made", async () => {
    // A search's RESULTS stayed inside the executor's context — that is the
    // delegation — so the calls are the only honest source for the desk's
    // "what the wait bought" line.
    const desk = stubDelegate({
      executor: {
        text: stepReply("Flights are around 180 return."),
        toolCalls: [
          { name: "search", input: { query: "lisbon flights may" } },
          { name: "search", input: { query: "lisbon flights june" } },
        ],
      },
    });

    const outcome = await executeStep(desk.delegate, "get to Lisbon", "Check prices", []);

    expect(outcome.searches).toEqual(["lisbon flights may", "lisbon flights june"]);
  });

  test("the executor is given its two tools and a bounded budget", async () => {
    // What this template still OWNS now that the loop is the runtime's: which
    // capabilities the step is worth, and how long it may spend.
    const desk = stubDelegate({ executor: stepReply("done") });
    await executeStep(desk.delegate, "objective", "step", []);

    const executor = desk.calls[0]?.subagent;
    expect(Object.keys(executor?.tools ?? {})).toEqual(["search", "read"]);
    expect(executor?.maxSteps).toBe(MAX_STEP_TURNS);
    // No `builtinTools`: both are this template's own tools over
    // `@alexkroman1/aai/tools`, which is the example that outlived the loop.
    expect(executor?.builtinTools).toBeUndefined();
  });

  test("an unsettled step is carried as a FIELD, not inferred from the wording", async () => {
    // `settled` is what a prompt could not hold: "say plainly rather than
    // inventing a result" was in `EXECUTOR_OUTPUT` from the start, and the desk
    // read one string, so a step that found nothing and a step that answered
    // arrived in the same shape.
    const desk = stubDelegate({
      executor: stepReply({ finding: "Nothing current on that route.", settled: false }),
    });

    const outcome = await executeStep(desk.delegate, "get to Lisbon", "Check prices", []);

    expect(outcome.settled).toBe(false);
    expect(outcome.result).toBe("Nothing current on that route.");
  });

  test("an answer the guardrail never accepted is not a settled step", async () => {
    // The run had its revision and still reported a step it never looked into,
    // so `accepted` is false — and a `settled: true` from an answer the runtime
    // refused is exactly the claim not to take at face value.
    const desk = stubDelegate({
      executor: {
        text: stepReply({ finding: "Flights are cheap in May.", settled: true }),
        complaint: "You reported the step as unsettled without searching for anything.",
      },
    });

    const outcome = await executeStep(desk.delegate, "get to Lisbon", "Check prices", []);

    expect(outcome.settled).toBe(false);
    expect(outcome.result).toBe("Flights are cheap in May.");
  });
});

describe("the executor's guardrail", () => {
  // Driven through `runGuardrail` rather than by calling the function, so what
  // is under test is the DEF: a guardrail dropped from `subagent()` fails here.
  const verdict = (answer: StepAnswer, searched: number) =>
    runGuardrail(executor, JSON.stringify(answer), {
      toolCalls: Array.from({ length: searched }, () => ({
        name: "search",
        input: { query: "anything" },
      })),
    });

  test("a settled step needs no search", () => {
    // Plenty of steps are summaries of what earlier ones found. A general "did
    // you search enough" would reject those and cost a whole extra run.
    expect(verdict({ finding: "Two of the three are already booked.", settled: true }, 0)).toBe(
      true,
    );
  });

  test("an unsettled step that really looked is accepted", () => {
    expect(verdict({ finding: "Could not find a fare for that date.", settled: false }, 2)).toBe(
      true,
    );
  });

  test("giving up without looking is sent back", () => {
    // The failure this template's headline claim is exposed to: reporting a
    // step unsettled from memory is cheaper than either honest move.
    expect(verdict({ finding: "I do not know what that costs.", settled: false }, 0)).toMatch(
      /without searching/,
    );
  });
});

describe("the executor's search tool", () => {
  test("renders the hits the model reasons over", async () => {
    vi.mocked(webSearch).mockResolvedValueOnce({
      results: [{ title: "Fares to Lisbon", url: "https://example.test/fares" }],
    });

    const rendered = await searchTool.execute({ query: "lisbon flights" }, createToolContext());

    expect(rendered).toContain("Fares to Lisbon");
    expect(rendered).toContain("https://example.test/fares");
  });

  test("a REFUSED search comes back as a failure, not as an empty web", async () => {
    // `webSearch` answers with `{ error }` rather than throwing, and measured,
    // DuckDuckGo answers 403 often enough to be the ordinary case. `orFail`
    // carries the refusal out as the tool's own `ToolFailure` — an empty list
    // would tell the executor there is nothing out there, and a thrown `Error`
    // would have the runtime log an ordinary 403 as an uncaught tool bug.
    vi.mocked(webSearch).mockResolvedValueOnce({ error: "403 Forbidden" });

    expect(await searchTool.execute({ query: "anything" }, createToolContext())).toEqual({
      error: "403 Forbidden",
    });
  });

  test("the caller's signal reaches the fetch", async () => {
    // A tool body gets a signal and `CallOptions` takes one; until they were
    // joined, a caller who hung up mid-step left a search running against a
    // third party.
    vi.mocked(webSearch).mockResolvedValueOnce({ results: [] });
    const ctx = createToolContext();

    await searchTool.execute({ query: "anything" }, ctx);

    expect(vi.mocked(webSearch).mock.calls[0]?.[0]).toMatchObject({ signal: ctx.signal });
  });

  test("says so when the web really had nothing", async () => {
    vi.mocked(webSearch).mockResolvedValueOnce({ results: [] });
    expect(await searchTool.execute({ query: "anything" }, createToolContext())).toBe(
      "No results.",
    );
  });
});

describe("the executor's read tool", () => {
  test("hands back the page body, capped", async () => {
    vi.mocked(visitWebpage).mockResolvedValueOnce({ content: "x".repeat(MAX_PAGE_CHARS + 500) });

    const body = await readTool.execute({ url: "https://example.test/fares" }, createToolContext());

    // A step is answered from a page's substance; the rest is context the run
    // pays for and the executor does not read.
    expect(String(body)).toHaveLength(MAX_PAGE_CHARS);
  });

  test("a page that would not load is not a page that said nothing", async () => {
    vi.mocked(visitWebpage).mockResolvedValueOnce({ error: "404 Not Found" });

    expect(
      await readTool.execute({ url: "https://example.test/gone" }, createToolContext()),
    ).toEqual({ error: "404 Not Found" });
  });

  test("the caller's signal reaches the fetch here too", async () => {
    vi.mocked(visitWebpage).mockResolvedValueOnce({ content: "anything" });
    const ctx = createToolContext();

    await readTool.execute({ url: "https://example.test/fares" }, ctx);

    expect(vi.mocked(visitWebpage).mock.calls[0]?.[1]).toMatchObject({ signal: ctx.signal });
  });
});

describe("normalizeAct", () => {
  test("a plan with steps is a plan", () => {
    expect(normalizeAct({ kind: "plan", steps: ["Do X"] }, "fallback")).toEqual({
      kind: "plan",
      steps: ["Do X"],
    });
  });

  test("'respond' with no response falls back rather than looping", () => {
    // The failure mode that matters on a phone call is a desk that never stops.
    expect(normalizeAct({ kind: "respond" }, "the last thing we know")).toEqual({
      kind: "respond",
      response: "the last thing we know",
    });
  });

  test("'plan' with no usable steps is read as an answer", () => {
    expect(normalizeAct({ kind: "plan", steps: ["  "] }, "nothing left")).toEqual({
      kind: "respond",
      response: "nothing left",
    });
    expect(normalizeAct({ kind: "plan", response: "here it is" }, "nothing left")).toEqual({
      kind: "respond",
      response: "here it is",
    });
  });
});

// ─── 2. The tools ────────────────────────────────────────────────────────────

describe("start_plan", () => {
  test("stores the objective and the steps", async () => {
    const { ctx } = scriptedDesk({
      steps: ["Check prices", "Compare hotels", "Book"],
    });
    const result = (await run("start_plan", { objective: "a weekend in Lisbon" }, ctx)) as {
      steps: string[];
    };
    expect(result.steps).toHaveLength(3);

    const state = stateOf(ctx);
    expect(state.objective).toBe("a weekend in Lisbon");
    expect(state.plan).toEqual(["Check prices", "Compare hotels", "Book"]);
    expect(state.pastSteps).toEqual([]);
    expect(state.revisions[0]).toContain("Planned 3 step(s)");
  });

  test("a broken model call is reported rather than thrown at the turn", async () => {
    // The default `createToolContext` generate rejects — a bad key looks the
    // same from here.
    const ctx = createToolContext({});
    expect(await run("start_plan", { objective: "anything" }, ctx)).toMatchObject({
      error: expect.stringContaining("planner failed"),
    });
  });
});

describe("work_next_step", () => {
  test("is refused before there is a plan, by the flow rather than by the body", async () => {
    const { ctx } = scriptedDesk();
    // The gate is `when: "working"`, so the refusal names the state the call is
    // actually in and quotes that state's instruction — which is what the model
    // needs in order to do the right thing on its own next turn.
    expect(await run("work_next_step", ctx)).toMatchObject({
      error: expect.stringContaining('this conversation is at "idle"'),
    });
    expect(await run("work_next_step", ctx)).toMatchObject({
      error: expect.stringContaining("use start_plan"),
    });
    // Refused means the body did not run: nothing was claimed off the plan.
    expect(stateOf(ctx).pastSteps).toEqual([]);
  });

  test("does the head step, records it, and takes the replanner's next plan", async () => {
    const { ctx } = scriptedDesk({
      steps: ["Check prices", "Compare hotels"],
      answers: ["Fares are about 180 return."],
      acts: [{ kind: "plan", steps: ["Compare hotels"] }],
    });
    await run("start_plan", { objective: "a weekend in Lisbon" }, ctx);

    const first = expectDialogOk<{
      finished: boolean;
      step: string;
      result: string;
      remaining: string[];
    }>(await run("work_next_step", ctx));
    expect(first.result.finished).toBe(false);
    expect(first.result.step).toBe("Check prices");
    expect(first.result.result).toContain("180");
    expect(first.result.remaining).toEqual(["Compare hotels"]);
    // Still working: nothing was concluded, so the flow has not moved on.
    expect(first.state).toBe("working");

    const state = stateOf(ctx);
    expect(state.pastSteps).toHaveLength(1);
    expect(state.plan).toEqual(["Compare hotels"]);
    expect(state.response).toBeNull();
  });

  test("a 'respond' act finishes the plan and clears what is left", async () => {
    const { ctx } = scriptedDesk({
      steps: ["Check prices", "Compare hotels"],
      answers: ["Fares are about 180 return."],
      acts: [{ kind: "respond", response: "Go in May — flights are about 180 return." }],
    });
    await run("start_plan", { objective: "a weekend in Lisbon" }, ctx);
    const answered = expectDialogOk<{ finished: boolean; response: string }>(
      await run("work_next_step", ctx),
    );

    expect(answered.result.finished).toBe(true);
    expect(answered.result.response).toContain("180");
    // A response is what sends ANSWERED — the flow and the data agree because
    // one tool call moved both.
    expect(answered.state).toBe("answered");
    expect(planFlow.position(ctx).state).toBe("answered");

    const state = stateOf(ctx);
    // The replanner deciding early is a good outcome, so the pending step goes.
    expect(state.plan).toEqual([]);
    expect(state.response).toBe(answered.result.response);

    // A finished plan is not worked again, and now it CANNOT be: the tool is
    // gated out of `answered` rather than returning a done-shaped result.
    expect(await run("work_next_step", ctx)).toMatchObject({
      error: expect.stringContaining('this conversation is at "answered"'),
    });
    expect(stateOf(ctx).pastSteps).toHaveLength(1);
  });

  test("the completed-step trail is capped, so the executor's prompt cannot grow forever", async () => {
    // `historyOf` renders every past step into the executor's prompt AND the
    // replanner's, so an uncapped list is a model bill that grows linearly with
    // the plan — the reason `planSlot` caps `pastSteps` at MAX_PAST_STEPS.
    const total = MAX_PAST_STEPS + 3;
    const { ctx } = scriptedDesk({
      steps: Array.from({ length: total }, (_, i) => `Step ${i + 1}`),
      answers: Array.from({ length: total }, (_, i) => `Found ${i + 1}.`),
      acts: Array.from({ length: total }, (_, i) => ({
        kind: "plan" as const,
        steps: Array.from({ length: total - i - 1 }, (_, j) => `Step ${i + j + 2}`),
      })),
    });
    await run("start_plan", { objective: "a long one" }, ctx);
    for (let i = 0; i < total; i++) await run("work_next_step", ctx);

    const state = stateOf(ctx);
    expect(state.pastSteps).toHaveLength(MAX_PAST_STEPS);
    // The OLDEST go: the replanner decides from what was just found, and its
    // fallback answer is the last entry.
    expect(state.pastSteps[0]?.step).toBe(`Step ${total - MAX_PAST_STEPS + 1}`);
    expect(state.pastSteps.at(-1)?.step).toBe(`Step ${total}`);
  });

  test("two independent contexts never share a plan", async () => {
    // What this really checks: the state lives in the SLOT and not in a
    // module-level variable. `scriptedToolContext()` hands each call its own
    // detached slot store, so the isolation is per CONTEXT — two distinct
    // session ids would prove nothing extra, and `sessionSlot` could stop
    // keying by session with this still passing.
    const { ctx: first } = scriptedDesk({ steps: ["Only step"] });
    const { ctx: second } = scriptedDesk({ steps: ["Only step"] });

    await run("start_plan", { objective: "mine" }, first);
    expect(stateOf(second).objective).toBeNull();
    // The FLOW is per-session too, not just the plan — `second` is still idle.
    expect(planFlow.position(second).state).toBe("idle");
    expect(await run("work_next_step", second)).toMatchObject({
      error: expect.stringContaining('this conversation is at "idle"'),
    });
  });
});

describe("revise_plan", () => {
  test("rewrites what is left, keeps what is done, and reopens a finished plan", async () => {
    const { ctx, model } = scriptedDesk({
      steps: ["Check Lisbon prices", "Book Lisbon"],
      answers: ["Lisbon is about 180 return."],
      acts: [
        { kind: "respond", response: "Lisbon in May, about 180." },
        { kind: "plan", steps: ["Check Porto prices"] },
      ],
    });
    await run("start_plan", { objective: "a weekend in Lisbon" }, ctx);
    await run("work_next_step", ctx);
    expect(stateOf(ctx).response).not.toBeNull();

    const revised = expectDialogOk<{ finished: boolean; remaining: string[] }>(
      await run("revise_plan", { instruction: "make it Porto instead" }, ctx),
    );
    expect(revised.result.finished).toBe(false);
    expect(revised.result.remaining).toEqual(["Check Porto prices"]);
    // REOPENED: the one transition that goes backwards, and the reason
    // `revise_plan` is legal in `answered` at all.
    expect(revised.state).toBe("working");

    const state = stateOf(ctx);
    // The old answer is no longer the answer — the caller moved the goalposts.
    expect(state.response).toBeNull();
    // Completed work survives a revision; that is what "only add steps that
    // still NEED to be done" means.
    expect(state.pastSteps).toHaveLength(1);
    expect(state.revisions.at(-1)).toContain("make it Porto instead");
    // The caller's words reach the replanner, which is the whole node.
    expect(model.calls.at(-1)?.prompt).toContain("make it Porto instead");
  });

  test("is refused before there is a plan", async () => {
    const { ctx } = scriptedDesk();
    expect(await run("revise_plan", { instruction: "change it" }, ctx)).toMatchObject({
      error: expect.stringContaining('this conversation is at "idle"'),
    });
  });

  test("the revision trail is capped, because it rides in every syncState frame", async () => {
    // The other cap `planSlot` declares, and the one nothing used to exercise:
    // `revisions` is pushed to by every tool that changes the plan and is sent
    // to the browser on each of them, so an uncapped trail is a frame that grows
    // for the whole call.
    const { ctx } = scriptedDesk({ steps: ["Only step"] });
    await run("start_plan", { objective: "a weekend in Lisbon" }, ctx);
    for (let index = 0; index < MAX_REVISIONS; index++) {
      await run("revise_plan", { instruction: `change ${index}` }, ctx);
    }

    const state = stateOf(ctx);
    expect(state.revisions).toHaveLength(MAX_REVISIONS);
    // The OLDEST goes, so `start_plan`'s own entry is the one pushed out — the
    // trail a caller wants read back is what has happened lately.
    expect(state.revisions[0]).toContain("change 0");
    expect(state.revisions.at(-1)).toContain(`change ${MAX_REVISIONS - 1}`);
  });

  test("a revision that answers outright lands in `answered`", async () => {
    const { ctx } = scriptedDesk({
      steps: ["Check Lisbon prices"],
      acts: [{ kind: "respond", response: "Nothing to do — you already booked it." }],
    });
    await run("start_plan", { objective: "a weekend in Lisbon" }, ctx);
    const revised = expectDialogOk<{ finished: boolean }>(
      await run("revise_plan", { instruction: "never mind, it is booked" }, ctx),
    );
    expect(revised.result.finished).toBe(true);
    expect(revised.state).toBe("answered");
  });
});

describe("plan_status", () => {
  test("reports done, remaining and the answer", async () => {
    const { ctx } = scriptedDesk({
      steps: ["Check prices", "Book"],
      answers: ["About 180 return."],
      acts: [{ kind: "plan", steps: ["Book"] }],
    });
    // Legal in every state, so it READS the position rather than being gated on
    // one — and "no plan yet" is the flow's own answer, not a third derivation
    // of `!objective`.
    expect(await run("plan_status", ctx)).toMatchObject({
      stage: "idle",
      next: expect.stringContaining("start_plan"),
      objective: null,
    });

    await run("start_plan", { objective: "a weekend in Lisbon" }, ctx);
    await run("work_next_step", ctx);
    expect(await run("plan_status", ctx)).toMatchObject({
      stage: "working",
      objective: "a weekend in Lisbon",
      remaining: ["Book"],
      response: null,
    });
  });
});

// ─── 3. The projection contract with client.tsx ─────────────────────────────

describe("planView projection", () => {
  test("an untouched call projects an empty plan, not undefined", () => {
    // Exactly the frame `client.tsx` renders before the first push — it passes
    // this same projection to `useAgentState`.
    expect(planProjection()).toEqual({
      objective: null,
      plan: [],
      done: [],
      response: null,
      revisions: [],
      progress: 0,
    });
  });

  test("progress is derived once, so the bar and any spoken count agree", async () => {
    const { ctx } = scriptedDesk({
      steps: ["One", "Two", "Three"],
      answers: ["Done one."],
      acts: [{ kind: "plan", steps: ["Two", "Three"] }],
    });
    await run("start_plan", { objective: "three things" }, ctx);
    expect(planView(stateOf(ctx)).progress).toBe(0);

    await run("work_next_step", ctx);
    const view = planView(stateOf(ctx));
    expect(view.progress).toBeCloseTo(1 / 3, 5);
    expect(view.done[0]?.step).toBe("One");
    expect(view.plan).toEqual(["Two", "Three"]);
  });
});
