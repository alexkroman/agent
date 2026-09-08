/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type {
  InferToolInput,
  InferToolOutput,
  TelephonyAccess,
  TelephonyCarrier,
} from "@alexkroman1/aai";
import {
  createToolContext,
  type StubGenerateRoute,
  stubGenerate,
  type TestToolContext,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { isToolFailure, type ToolFailure } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";

import { MAX_ATTEMPTS, runCorrectiveRag } from "./procedure.ts";
import {
  ANSWER_SYSTEM,
  ANSWERS_SYSTEM,
  DOC_GRADER_SYSTEM,
  GROUNDED_SYSTEM,
  REWRITE_SYSTEM,
} from "./prompts.ts";
import { ASKED_CAP, retrieve, supportProjection, supportSlot, supportView } from "./shared.ts";
/** TYPE-only, so nothing here re-registers a tool module: the defs under test
 *  still come from `agentDef`, which is what a deploy resolves. */
import type AnswerQuestion from "./tools/answer_question.ts";
import type LogTicket from "./tools/log_ticket.ts";

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

  /**
   * One of the two GENERATION graders, which differ only in their queue and the
   * node they record.
   *
   * `StubGenerateRoute` is what one entry of the table below is, and naming it
   * is the check worth having here: a route may answer a bare string — right
   * for the free-text nodes, and for a grader it would leave the schema
   * overload with no `object` to read, which is the one failure a stub of a
   * `ctx.generate({ schema })` can produce.
   */
  const verdictRoute = (
    node: string,
    queue: ("yes" | "no")[],
    reason: string,
  ): StubGenerateRoute => {
    return () => {
      const verdict = queue.shift() ?? "yes";
      calls.push(`${node}:${verdict}`);
      return { object: { score: verdict, reason } };
    };
  };

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
    [GROUNDED_SYSTEM]: verdictRoute(
      "grade_generation_v_documents",
      grounded,
      "not in the documents",
    ),
    [ANSWERS_SYSTEM]: verdictRoute("grade_generation_v_question", useful, "answers something else"),
  });

  return { generate, calls };
}

/** A tool by the name the model calls it by, bound to this agent. The lookup,
 *  its "no such tool" message and the args-or-context shape are all
 *  `toolRunner`'s (`@alexkroman1/aai/testing`); what is local is only which
 *  agent it runs against. */
const run = toolRunner(agentDef);

/**
 * A tool context wired to a scripted model — the pair every tool case needs.
 *
 * `TestToolContext` is the SDK's `ToolContext` plus the `sent` log, and naming
 * it is what lets this hand one value back where five cases were destructuring
 * a `{ generate }` only to feed it straight into `createToolContext`.
 */
function supportContext(script: Script): TestToolContext {
  return createToolContext({ generate: scriptedModel(script).generate });
}

/**
 * What `answer_question` really answers, from the tool's OWN return type.
 *
 * `run` is typed `unknown` — the registry lookup is by string — so reading a
 * field off an answer needs an assertion either way. `InferToolOutput` makes it
 * an assertion about the TOOL rather than a shape retyped beside it, so
 * renaming `answersTheQuestion` reddens here instead of quietly comparing
 * `undefined`. The tool has three legal outcomes, so each case `Extract`s the
 * arm it is about.
 *
 * The SDK's `expectToolOk` is deliberately not used: it unwraps a `dialog()`
 * envelope and throws for a plain `tool()`, which all three of these are.
 */
type Lookup = Exclude<InferToolOutput<typeof AnswerQuestion>, ToolFailure>;
type Graded = Extract<Lookup, { answer: string }>;
type Withheld = Extract<Lookup, { answer: null }>;

/**
 * The value a tool answered, or a failure at the CALL.
 *
 * A plain tool answers its own value or a `ToolFailure`, so a bare cast hands a
 * refusal's `{ error }` to the assertions and dies a few lines later reading
 * `undefined` off it. `isToolFailure` is the SDK's own predicate for that
 * envelope; what is local is only the sentence.
 */
function answered<T>(result: unknown): T {
  if (isToolFailure(result)) throw new Error(`the tool refused: ${result.error}`);
  return result as T;
}

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

/**
 * The tool's OWN input type, so a field renamed in `tools/answer_question.ts`
 * reddens here — `toolRunner` looks a tool up by string and takes a bare
 * record, which is exactly enough freedom to pass `{ questoin }` and watch the
 * graph retrieve nothing.
 */
function asks(question: string): InferToolInput<typeof AnswerQuestion> {
  return { question };
}

describe("answer_question", () => {
  test("hands back the answer, its sources and its verdicts, and records the trace", async () => {
    const ctx = supportContext({
      relevant: (id) => id === "D8",
      answers: ["Area outages are on the status page, and rebooting will not help."],
    });
    const result = answered<Graded>(await run("answer_question", asks("is there an outage"), ctx));

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
    const ctx = supportContext({ relevant: () => false });
    const result = answered<Withheld>(
      await run("answer_question", asks("do you sell phones"), ctx),
    );
    expect(result.answer).toBeNull();
    expect(result.guidance).toContain("log_ticket");
  });

  test("a broken model call is reported rather than thrown at the turn", async () => {
    // ctx.generate rejecting is the default `createToolContext` gives — a bad
    // key in production looks the same from here.
    const ctx = createToolContext({});
    const result = await run("answer_question", asks("anything"), ctx);
    // The failure envelope is the SDK's, so the spec asks the SDK whether this
    // is one rather than casting to `{ error }` — a cast reads `undefined` off
    // a SUCCESS and fails three lines later on something else.
    if (!isToolFailure(result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
    expect(result.error).toContain("knowledge base lookup failed");
  });

  test("two independent contexts never see each other's traces or tickets", async () => {
    // What this really checks: the state lives in the SLOT and not in a
    // module-level variable. `createToolContext()` hands each call its own
    // detached slot store, so the isolation is per CONTEXT — two distinct
    // session ids would prove nothing extra, and `sessionSlot` could stop
    // keying by session with this still passing.
    const { generate } = scriptedModel({ relevant: (id) => id === "D2", answers: ["Reboot it."] });
    const first = createToolContext({ generate });
    const second = createToolContext({ generate });

    await run("answer_question", asks("how do I reboot"), first);
    expect(supportSlot.get(second).trace).toBeNull();
    expect(supportSlot.get(first).trace).not.toBeNull();
  });
});

describe("the support slot", () => {
  test("bounds the asked list at the cap it declares, dropping the oldest", () => {
    // The bound is `caps` on the SLOT rather than a `pushCapped` inside the
    // tool, so it holds for whatever path wrote — which is what this drives:
    // plain `update` windows, no tool call. `asked` rides in every `syncState`
    // frame, so an unbounded one is a call that grows its own state forever.
    const ctx = createToolContext({});
    for (let n = 1; n <= ASKED_CAP + 3; n++) {
      supportSlot.update(ctx, (state) => {
        state.asked.push(`question ${n}`);
      });
    }
    const { asked } = supportSlot.get(ctx);
    expect(asked).toHaveLength(ASKED_CAP);
    expect(asked[0]).toBe("question 4");
    expect(asked.at(-1)).toBe(`question ${ASKED_CAP + 3}`);
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
