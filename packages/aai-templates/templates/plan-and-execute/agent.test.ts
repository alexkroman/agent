/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type { ToolContext } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDialogOk,
  stubGenerate,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

import { executeStep, MAX_STEP_SEARCHES, normalizeAct, planNode } from "./procedure.ts";
import { EXECUTOR_SYSTEM, PLANNER_SYSTEM, REPLANNER_SYSTEM, REVISE_SYSTEM } from "./prompts.ts";
import type { SearchFn } from "./shared.ts";
import { MAX_PAST_STEPS, planFlow, planProjection, planSlot, planView } from "./shared.ts";

// ─── A scripted model ────────────────────────────────────────────────────────
//
// Each node is one `ctx.generate` call carrying its own system prompt, so
// `stubGenerate` — whose script IS keyed by system prompt — drives the whole
// loop with no model and no network. `calls` is every call the fake took, which
// is how the "a failed search goes back to the model" assertion is made: it
// asserts on the PROMPT the next turn carried.

interface Script {
  steps?: string[];
  /** One entry per executor turn: search that query, or answer with that text. */
  turns?: ({ search: string } | { answer: string })[];
  /** One entry per replan/revise call. */
  acts?: { kind: "respond" | "plan"; response?: string; steps?: string[] }[];
}

function scriptedModel(script: Script = {}) {
  const turns = [...(script.turns ?? [{ answer: "Settled it." }])];
  const acts = [...(script.acts ?? [])];
  // The replanner and the reviser are the same node with a different brief, so
  // they share one queue — which is what the "revise then carry on" test rests on.
  const act = () => ({ object: acts.shift() ?? { kind: "respond", response: "All done." } });

  return stubGenerate({
    [PLANNER_SYSTEM]: { object: { steps: script.steps ?? ["Only step"] } },
    [EXECUTOR_SYSTEM]: () => {
      const turn = turns.shift() ?? { answer: "Settled it." };
      return "search" in turn
        ? { object: { action: "search", query: turn.search } }
        : { object: { action: "answer", answer: turn.answer } };
    },
    [REPLANNER_SYSTEM]: act,
    [REVISE_SYSTEM]: act,
  });
}

/** A searcher that never touches the network. The tools use `liveSearch`, so
 *  every tool-level test below scripts the executor to answer without one. */
function fakeSearch(hits: Record<string, { title: string; url: string }[]>): {
  search: SearchFn;
  queries: string[];
} {
  const queries: string[] = [];
  const search: SearchFn = async (query) => {
    queries.push(query);
    const found = hits[query];
    if (!found) throw new Error("search backend unavailable");
    return found;
  };
  return { search, queries };
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
    const { generate, calls } = scriptedModel({ steps: ["Check prices", "Book it"] });
    expect(await planNode(generate, "get me to Lisbon in May")).toEqual([
      "Check prices",
      "Book it",
    ]);
    expect(calls[0]?.prompt).toContain("get me to Lisbon in May");
  });
});

describe("executeStep", () => {
  test("searches, reads the results, then answers — and reports what it searched", async () => {
    const { generate, calls } = scriptedModel({
      turns: [{ search: "lisbon flights may" }, { answer: "Flights are around 180 return." }],
    });
    const { search, queries } = fakeSearch({
      "lisbon flights may": [{ title: "Fares to Lisbon", url: "https://example.test/fares" }],
    });

    const outcome = await executeStep(generate, search, "get to Lisbon", "Check prices", []);
    expect(queries).toEqual(["lisbon flights may"]);
    expect(outcome.result).toContain("180");
    expect(outcome.searches).toEqual(["lisbon flights may"]);
    // The results are what the second turn reasons over, not a note in a log.
    expect(calls[1]?.prompt).toContain("https://example.test/fares");
  });

  test("a failed search goes back to the model rather than only to a log", async () => {
    // Told nothing, the model reads silence as "no such pages exist" and burns
    // the rest of its budget re-asking the same question.
    const { generate, calls } = scriptedModel({
      turns: [{ search: "unindexed thing" }, { answer: "Could not confirm that." }],
    });
    const { search } = fakeSearch({});

    const outcome = await executeStep(generate, search, "objective", "Check the thing", []);
    expect(calls[1]?.prompt).toContain("search backend unavailable");
    expect(outcome.result).toBe("Could not confirm that.");
  });

  test("the search budget is a bound, not a suggestion", async () => {
    const { generate, calls } = scriptedModel({
      // Three searches asked for, two allowed.
      turns: [{ search: "a" }, { search: "b" }, { search: "c" }],
    });
    const { search, queries } = fakeSearch({
      a: [{ title: "A", url: "https://example.test/a" }],
      b: [{ title: "B", url: "https://example.test/b" }],
      c: [{ title: "C", url: "https://example.test/c" }],
    });

    const outcome = await executeStep(generate, search, "objective", "step", []);
    expect(queries).toHaveLength(MAX_STEP_SEARCHES);
    // The last turn is told the budget is gone, which is what turns a search
    // loop into an answer.
    expect(calls.at(-1)?.prompt).toContain("search budget");
    expect(outcome.result).toBe("This step could not be settled within its budget.");
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
    const { generate } = scriptedModel({ steps: ["Check prices", "Compare hotels", "Book"] });
    const ctx = createToolContext({ generate });
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
    const { generate } = scriptedModel();
    const ctx = createToolContext({ generate });
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
    const { generate } = scriptedModel({
      steps: ["Check prices", "Compare hotels"],
      turns: [{ answer: "Fares are about 180 return." }],
      acts: [{ kind: "plan", steps: ["Compare hotels"] }],
    });
    const ctx = createToolContext({ generate });
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
    const { generate } = scriptedModel({
      steps: ["Check prices", "Compare hotels"],
      turns: [{ answer: "Fares are about 180 return." }],
      acts: [{ kind: "respond", response: "Go in May — flights are about 180 return." }],
    });
    const ctx = createToolContext({ generate });
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
    // the plan — the reason `recordStep` holds MAX_PAST_STEPS.
    const total = MAX_PAST_STEPS + 3;
    const { generate } = scriptedModel({
      steps: Array.from({ length: total }, (_, i) => `Step ${i + 1}`),
      turns: Array.from({ length: total }, (_, i) => ({ answer: `Found ${i + 1}.` })),
      acts: Array.from({ length: total }, (_, i) => ({
        kind: "plan" as const,
        steps: Array.from({ length: total - i - 1 }, (_, j) => `Step ${i + j + 2}`),
      })),
    });
    const ctx = createToolContext({ generate });
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
    // module-level variable. `createToolContext()` hands each call its own
    // detached slot store, so the isolation is per CONTEXT — two distinct
    // session ids would prove nothing extra, and `sessionSlot` could stop
    // keying by session with this still passing.
    const { generate } = scriptedModel({ steps: ["Only step"] });
    const first = createToolContext({ generate });
    const second = createToolContext({ generate });

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
    const { generate, calls } = scriptedModel({
      steps: ["Check Lisbon prices", "Book Lisbon"],
      turns: [{ answer: "Lisbon is about 180 return." }],
      acts: [
        { kind: "respond", response: "Lisbon in May, about 180." },
        { kind: "plan", steps: ["Check Porto prices"] },
      ],
    });
    const ctx = createToolContext({ generate });
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
    expect(calls.at(-1)?.prompt).toContain("make it Porto instead");
  });

  test("is refused before there is a plan", async () => {
    const { generate } = scriptedModel();
    const ctx = createToolContext({ generate });
    expect(await run("revise_plan", { instruction: "change it" }, ctx)).toMatchObject({
      error: expect.stringContaining('this conversation is at "idle"'),
    });
  });

  test("a revision that answers outright lands in `answered`", async () => {
    const { generate } = scriptedModel({
      steps: ["Check Lisbon prices"],
      acts: [{ kind: "respond", response: "Nothing to do — you already booked it." }],
    });
    const ctx = createToolContext({ generate });
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
    const { generate } = scriptedModel({
      steps: ["Check prices", "Book"],
      turns: [{ answer: "About 180 return." }],
      acts: [{ kind: "plan", steps: ["Book"] }],
    });
    const ctx = createToolContext({ generate });
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
    const { generate } = scriptedModel({
      steps: ["One", "Two", "Three"],
      turns: [{ answer: "Done one." }],
      acts: [{ kind: "plan", steps: ["Two", "Three"] }],
    });
    const ctx = createToolContext({ generate });
    await run("start_plan", { objective: "three things" }, ctx);
    expect(planView(stateOf(ctx)).progress).toBe(0);

    await run("work_next_step", ctx);
    const view = planView(stateOf(ctx));
    expect(view.progress).toBeCloseTo(1 / 3, 5);
    expect(view.done[0]?.step).toBe("One");
    expect(view.plan).toEqual(["Two", "Three"]);
  });
});
