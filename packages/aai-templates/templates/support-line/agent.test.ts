/// <reference types="vite/client" />

import type { GenerateFn, ToolContext } from "@alexkroman1/aai";
import {
  createToolContext,
  runTool,
  stubGenerate,
  withDiscoveredTools,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import authoredAgent from "./agent.ts";

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * The glob is written HERE rather than reached for from a shared helper because
 * this file SHIPS: it is what a scaffolded project runs, so it may not import
 * anything outside its own template, and `import.meta.glob` is expanded against
 * the file containing it either way. This is the pattern a user writes.
 */
const agentDef = withDiscoveredTools(
  authoredAgent,
  import.meta.glob("./tools/*.ts", { eager: true }),
);

import { MAX_ATTEMPTS, runCorrectiveRag } from "./procedure.ts";
import {
  ANSWER_SYSTEM,
  ANSWERS_SYSTEM,
  DOC_GRADER_SYSTEM,
  GROUNDED_SYSTEM,
  REWRITE_SYSTEM,
} from "./prompts.ts";
import { retrieve, supportProjection, supportSlot, supportView } from "./shared.ts";

// ─── A scripted model ────────────────────────────────────────────────────────
//
// Every node in the graph is one `ctx.generate` call, and each call is
// identified by the system prompt it carries — so a fake that switches on
// `options.system` can drive the graph down any path, deterministically, with
// no model and no network. `calls` is the transcript, which is what the routing
// assertions read: the point of these tests is WHICH nodes ran, not what a
// model would have said.

interface Script {
  /** Whether the grader passes a document, per retrieval attempt (1-based). */
  relevant?: (docId: string, attempt: number) => boolean;
  /** What `transform_query` rewrites to. */
  rewrite?: string;
  /** Answers, consumed one per `generate` node. */
  answers?: string[];
  /** Verdicts, consumed one per grader call. Default: pass. */
  grounded?: ("yes" | "no")[];
  useful?: ("yes" | "no")[];
}

function scriptedModel(script: Script = {}) {
  // The NODE transcript, which is this template's own and is why the routes
  // below are functions: `stubGenerate` records the calls, and what these
  // assertions need is the graph's node names, labelled with their verdicts.
  const calls: string[] = [];
  let attempt = 1;
  const answers = [...(script.answers ?? [])];
  const grounded = [...(script.grounded ?? [])];
  const useful = [...(script.useful ?? [])];

  const { generate } = stubGenerate({
    [DOC_GRADER_SYSTEM]: (call) => {
      const id = /\[(D\d+)\]/.exec(call.prompt)?.[1] ?? "?";
      calls.push(`grade_documents:${id}`);
      const pass = script.relevant ? script.relevant(id, attempt) : true;
      return { object: { score: pass ? "yes" : "no", reason: `graded ${id}` } };
    },
    [REWRITE_SYSTEM]: () => {
      calls.push("transform_query");
      attempt++;
      return script.rewrite ?? "rewritten query";
    },
    [ANSWER_SYSTEM]: () => {
      calls.push("generate");
      return answers.shift() ?? "The documented answer.";
    },
    [GROUNDED_SYSTEM]: () => {
      const verdict = grounded.shift() ?? "yes";
      calls.push(`grade_generation_v_documents:${verdict}`);
      return { object: { score: verdict, reason: "grounded verdict" } };
    },
    [ANSWERS_SYSTEM]: () => {
      const verdict = useful.shift() ?? "yes";
      calls.push(`grade_generation_v_question:${verdict}`);
      return { object: { score: verdict, reason: "usefulness verdict" } };
    },
  });

  return { generate, calls };
}

function makeCtx(generate: GenerateFn, sessionId?: string) {
  return createToolContext({ generate, ...(sessionId ? { sessionId } : {}) });
}

/** A tool by the name the model calls it by, bound to this agent. The lookup
 *  and its "no such tool" message are `runTool`'s (`@alexkroman1/aai/testing`);
 *  what is local is only which agent they run against. */
const run = (name: string, args: Record<string, unknown>, ctx: ToolContext) =>
  runTool(agentDef, name, args, ctx);

/** Node names without the per-call suffix, for sequence assertions. */
function nodes(calls: string[]): string[] {
  return calls.map((call) => call.split(":")[0] ?? call);
}

/** The same sequence with consecutive repeats collapsed — `grade_documents`
 *  runs once per retrieved document, and the count is `RETRIEVE_K`'s business
 *  rather than the routing's. */
function phases(calls: string[]): string[] {
  return nodes(calls).filter((node, index, all) => node !== all[index - 1]);
}

// ─── 1. The retriever ────────────────────────────────────────────────────────

describe("retrieval (shared.ts)", () => {
  test("ranks the document a caller's words actually point at", () => {
    expect(retrieve("my broadband light is red")[0]?.doc.id).toBe("D1");
    expect(retrieve("nobody was home for the engineer")[0]?.doc.id).toBe("D6");
  });

  test("and gets the neighbouring document first often enough to need a grader", () => {
    // "what does it cost to leave my contract early" ranks D7 (moving home,
    // which mentions the contract AND the early exit fee) above D5, the
    // document that actually answers it. Both come back, which is what makes
    // the run recoverable — the document grader is the node that stops the
    // neighbour being spoken as the answer, and this is the retrieval it is
    // grading.
    const ranked = retrieve("what does it cost to leave my contract early").map(
      (one) => one.doc.id,
    );
    expect(ranked[0]).toBe("D7");
    expect(ranked).toContain("D5");
  });

  test("returns nothing for a query with no content words", () => {
    // Every term is a stopword, so there is nothing to rank — which the graph
    // treats as a failed retrieval rather than as an empty knowledge base.
    expect(retrieve("what about the one that you have")).toEqual([]);
  });

  test("a question phrased the way a caller speaks misses, which is the case the rewrite exists for", () => {
    // The bait for the whole template: no document contains "dying", so lexical
    // retrieval cannot reach D10 until `transform_query` supplies the words a
    // document about it would use.
    const spoken = retrieve("my internet keeps dying at night").map((one) => one.doc.id);
    expect(spoken).not.toContain("D10");
    expect(retrieve("evening slowdown congestion peak time")[0]?.doc.id).toBe("D10");
  });
});

// ─── 2. The graph's routing ──────────────────────────────────────────────────

describe("corrective-RAG graph", () => {
  test("the straight path grades, answers, and checks the answer twice", async () => {
    const { generate, calls } = scriptedModel({
      relevant: (id) => id === "D2",
      answers: ["Power the hub off at the wall for thirty seconds."],
    });
    const trace = await runCorrectiveRag(generate, "how do I reboot the hub");

    expect(phases(calls)).toEqual([
      "grade_documents",
      "generate",
      "grade_generation_v_documents",
      "grade_generation_v_question",
    ]);
    expect(trace.answer).toContain("thirty seconds");
    expect(trace.grounded).toBe(true);
    expect(trace.useful).toBe(true);
    expect(trace.rewrites).toBe(0);
    expect(trace.exhausted).toBe(false);
    expect(trace.docs.filter((doc) => doc.relevant).map((doc) => doc.id)).toEqual(["D2"]);
  });

  test("nothing relevant rewrites the query and retries — the corrective edge", async () => {
    const { generate, calls } = scriptedModel({
      // First retrieval is graded useless; after the rewrite everything passes.
      relevant: (_id, attempt) => attempt > 1,
      rewrite: "evening slowdown congestion peak time",
      answers: ["There is no traffic management, so evening slowdowns are local."],
    });
    const trace = await runCorrectiveRag(generate, "my internet keeps dying at night");

    expect(calls.filter((call) => call === "transform_query")).toHaveLength(1);
    expect(trace.rewrites).toBe(1);
    expect(trace.query).toBe("evening slowdown congestion peak time");
    expect(trace.answer).toContain("traffic management");
    // The trace names the nodes the way their graph does, which is what the
    // sidebar renders.
    expect(trace.steps.map((entry) => entry.node)).toContain("transform_query");
  });

  test("a caller question nothing covers ends exhausted, with no answer", async () => {
    const { generate, calls } = scriptedModel({ relevant: () => false });
    const trace = await runCorrectiveRag(generate, "can I get a landline installed");

    expect(trace.answer).toBeNull();
    expect(trace.exhausted).toBe(true);
    expect(trace.rewrites).toBe(MAX_ATTEMPTS - 1);
    // It never reached the answer node: nothing was graded relevant to answer
    // FROM, which is the whole point of grading before generating.
    expect(nodes(calls)).not.toContain("generate");
  });

  test("an ungrounded answer is regenerated once and then withheld", async () => {
    const { generate, calls } = scriptedModel({
      relevant: (id) => id === "D5",
      answers: ["The exit fee is nine months.", "The exit fee is still nine months."],
      grounded: ["no", "no"],
    });
    const trace = await runCorrectiveRag(generate, "what is the early exit fee");

    expect(calls.filter((call) => call === "generate")).toHaveLength(2);
    // Withheld rather than spoken with a caveat: an answer the grader says is
    // not in the documents is the one thing a support line must never say.
    expect(trace.answer).toBeNull();
    expect(trace.grounded).toBe(false);
    expect(trace.exhausted).toBe(true);
    expect(nodes(calls)).not.toContain("grade_generation_v_question");
  });

  test("a grounded but beside-the-point answer rewrites once, then is returned with its verdict", async () => {
    const { generate } = scriptedModel({
      relevant: () => true,
      useful: ["no", "no"],
      // The rewrite has to retrieve something, or the second attempt ends in
      // the no-documents branch instead of the one under test.
      rewrite: "direct debit bill payment date",
      answers: ["Bills go out on the first.", "Bills go out on the first."],
    });
    const trace = await runCorrectiveRag(generate, "when will my money actually leave my account");

    expect(trace.rewrites).toBe(1);
    expect(trace.useful).toBe(false);
    expect(trace.exhausted).toBe(true);
    // Still returned: it is grounded, and the tool tells the model to offer a
    // ticket alongside it rather than to withhold it.
    expect(trace.answer).toBe("Bills go out on the first.");
  });
});

// ─── 3. The tools ────────────────────────────────────────────────────────────

describe("answer_question", () => {
  test("hands back the answer, its sources and its verdicts, and records the trace", async () => {
    const { generate } = scriptedModel({
      relevant: (id) => id === "D8",
      answers: ["Area outages are on the status page, and rebooting will not help."],
    });
    const ctx = makeCtx(generate);
    const result = (await run("answer_question", { question: "is there an outage" }, ctx)) as {
      answer: string;
      sources: string[];
      grounded: boolean;
      answersTheQuestion: boolean;
      guidance?: string;
    };

    expect(result.answer).toContain("status page");
    expect(result.sources).toEqual(["Checking for an outage in your area"]);
    expect(result.grounded).toBe(true);
    expect(result.answersTheQuestion).toBe(true);
    expect(result.guidance).toBeUndefined();

    const state = supportSlot.get(ctx);
    expect(state.asked).toEqual(["is there an outage"]);
    expect(state.trace?.answer).toBe(result.answer);
  });

  test("with nothing grounded it returns no answer and points at the ticket", async () => {
    const { generate } = scriptedModel({ relevant: () => false });
    const ctx = makeCtx(generate);
    const result = (await run("answer_question", { question: "do you sell phones" }, ctx)) as {
      answer: null;
      guidance: string;
    };
    expect(result.answer).toBeNull();
    expect(result.guidance).toContain("log_ticket");
  });

  test("a broken model call is reported rather than thrown at the turn", async () => {
    // ctx.generate rejecting is the default `createToolContext` gives — a bad
    // key in production looks the same from here.
    const ctx = createToolContext({});
    const result = (await run("answer_question", { question: "anything" }, ctx)) as {
      error: string;
    };
    expect(result.error).toContain("knowledge base lookup failed");
  });

  test("two independent contexts never see each other's traces or tickets", async () => {
    // What this really checks: the state lives in the SLOT and not in a
    // module-level variable. `createToolContext()` hands each call its own
    // detached slot store, so the isolation is per CONTEXT — two distinct
    // session ids would prove nothing extra, and `sessionSlot` could stop
    // keying by session with this still passing.
    const { generate } = scriptedModel({ relevant: (id) => id === "D2", answers: ["Reboot it."] });
    const first = makeCtx(generate);
    const second = makeCtx(generate);

    await run("answer_question", { question: "how do I reboot" }, first);
    expect(supportSlot.get(second).trace).toBeNull();
    expect(supportSlot.get(first).trace).not.toBeNull();
  });
});

describe("log_ticket", () => {
  test("logs a reference and keeps the callback number off the wire", async () => {
    const ctx = createToolContext({});
    const logged = (await run(
      "log_ticket",
      { question: "landline install", callback: "07700 900123" },
      ctx,
    )) as { reference: string };
    expect(logged.reference).toBe("TCK4001");

    const state = supportSlot.get(ctx);
    expect(state.ticket?.callback).toBe("07700 900123");
    // The projection is the privacy boundary — only the reference crosses.
    const view = supportView(state);
    expect(view.ticket).toBe("TCK4001");
    expect(JSON.stringify(view)).not.toContain("900123");
  });
});

describe("supportView projection", () => {
  test("an untouched call projects an empty trace, not undefined", () => {
    // Exactly the frame `client.tsx` renders before the first push — it passes
    // this same projection to `useAgentState`.
    expect(supportProjection()).toMatchObject({
      product: "Meridian Fibre",
      trace: null,
      asked: [],
      ticket: null,
    });
  });
});
