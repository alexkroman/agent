/**
 * The corrective-RAG graph, as a graph.
 *
 * This is the port of the self-RAG / CRAG graph (see `prompts.ts` for the
 * attribution), and it is now the same SHAPE as the thing it ports: their
 * control flow is edges between nodes, and so is this.
 *
 * ```text
 * retrieve → grade_documents → decide_to_generate
 *                                ├─ no relevant docs → transform_query → retrieve
 *                                └─ generate → grade_generation_v_documents
 *                                                ├─ not grounded → generate (once)
 *                                                └─ grade_generation_v_question
 *                                                     ├─ not useful → transform_query
 *                                                     └─ done
 * ```
 *
 * **It used to be a `while` loop with the node names preserved in a trace**, so
 * that a run stayed readable as the graph it came from. That worked and cost two
 * things worth getting back. The node names were a STRING passed to a `step()`
 * helper beside the code that did the work, so nothing stopped the two drifting;
 * here a node IS a state and the trace is written by that state's `entry`, so a
 * renamed node cannot keep an old label. And the routing was spread across a
 * `continue`, a nested `for`, and four early `return`s — the exact structure a
 * statechart exists to make declarative. `xstate` is a dependency of the SDK, so
 * this costs the template nothing to reach for.
 *
 * **The budget is the mechanism, not the prompt.** A graph with a
 * `transform_query` edge can cycle, and their notebooks bound it with a recursion
 * limit that raises on hit. A caller is holding the line, so the bound here is
 * two attempts and one regeneration — {@link MAX_ATTEMPTS} — expressed as GUARDS
 * (`canRetry`, `canRegenerate`) rather than as loop conditions. Running out is an
 * ANSWER (`exhausted`, the caller is offered a ticket) rather than an error: an
 * agent that cannot say "I don't have that documented" is the failure the whole
 * grading apparatus exists to prevent, so it has to be a reachable state — and
 * here it is literally one.
 *
 * **Documents are graded CONCURRENTLY.** Their loop is sequential because a
 * notebook does not care; four serial grader calls is four round trips of dead
 * air on a phone. The grades are independent, so the fan-out is free — it lives
 * inside the `gradeDocuments` node (`nodes.ts`), not in the routing.
 *
 * Two things about this machine are deliberately unlike a {@link flow}. It is
 * NOT persisted — it lives and dies inside one `answer_question` call, so its
 * context may hold a `GenerateFn`, which no stored slot could. And it drives
 * ITSELF to completion through invoked actors, where a flow is moved one event
 * at a time by the caller's turns. A flow models where a CONVERSATION is; this
 * models one unit of work inside a single tool call.
 */

import type { GenerateFn } from "@alexkroman1/aai";
import { assign, createActor, fromPromise, setup, toPromise } from "xstate";
import {
  generateAnswer,
  gradeDocuments,
  gradeGrounded,
  gradeUseful,
  transformQuery,
  type Verdict,
} from "./nodes.ts";
import type { AnswerTrace, Doc, GradedDoc, TraceStep } from "./shared.ts";
import { retrieve } from "./shared.ts";

/** Retrieve-and-answer attempts, i.e. one query rewrite. */
export const MAX_ATTEMPTS = 2;
/** Regenerations after a "not grounded" verdict, within one attempt. */
export const MAX_REGENERATIONS = 1;

/**
 * What the machine carries: the trace it is building, plus the two counters the
 * guards read and the documents the current attempt is answering from.
 *
 * `generate` rides in here because this machine is never stored — see the module
 * doc. A {@link flow}'s context has to survive `structuredClone`; this one only
 * has to survive one tool call.
 */
interface Ctx extends AnswerTrace {
  generate: GenerateFn;
  /** 1-based, bounded by {@link MAX_ATTEMPTS}. */
  attempt: number;
  /** Regenerations spent WITHIN this attempt; reset by `transform_query`. */
  regenerations: number;
  /** What this attempt's query retrieved, before grading. */
  retrieved: Doc[];
  /** The documents this attempt retrieved and the grader passed. */
  relevant: Doc[];
}

/**
 * One trace entry, as a `{ type: "note", params }` action.
 *
 * A parameterized action declared INSIDE `setup` rather than a helper that
 * returns a bare `assign`: an action built outside carries no knowledge of this
 * machine's actors, so `exactOptionalPropertyTypes` refuses it wherever the
 * machine expects one of its own. `params` may be a function, which is what lets
 * a detail string read the context it is describing.
 */
function noteAt(node: string, detail: string): { type: "note"; params: NoteParams } {
  return { type: "note", params: { node, detail } };
}

/** The same, for a detail computed from the context the entry describes. */
function noteFrom(node: string, detail: (context: Ctx) => string) {
  return {
    type: "note" as const,
    params: ({ context }: { context: Ctx }): NoteParams => ({ node, detail: detail(context) }),
  };
}

interface NoteParams {
  node: string;
  detail: string;
}

const machine = setup({
  types: {} as {
    context: Ctx;
    input: { generate: GenerateFn; question: string };
    output: AnswerTrace;
  },
  actors: {
    gradeDocuments: fromPromise(
      async ({ input }: { input: { ctx: Ctx; docs: Doc[] } }): Promise<GradedDoc[]> =>
        await gradeDocuments(input.ctx.generate, input.ctx.question, input.docs),
    ),
    generateAnswer: fromPromise(
      async ({ input }: { input: { ctx: Ctx } }): Promise<string> =>
        await generateAnswer(input.ctx.generate, input.ctx.question, input.ctx.relevant),
    ),
    gradeGrounded: fromPromise(
      async ({ input }: { input: { ctx: Ctx } }): Promise<Verdict> =>
        await gradeGrounded(input.ctx.generate, input.ctx.relevant, input.ctx.answer ?? ""),
    ),
    gradeUseful: fromPromise(
      async ({ input }: { input: { ctx: Ctx } }): Promise<Verdict> =>
        await gradeUseful(input.ctx.generate, input.ctx.question, input.ctx.answer ?? ""),
    ),
    transformQuery: fromPromise(
      async ({ input }: { input: { ctx: Ctx } }): Promise<string> =>
        await transformQuery(input.ctx.generate, input.ctx.question),
    ),
  },
  actions: {
    note: assign({
      steps: ({ context }, params: NoteParams): TraceStep[] => [
        ...context.steps,
        { node: params.node, detail: params.detail },
      ],
    }),
  },
  guards: {
    /** Their `decide_to_generate`: is there anything to answer FROM? */
    hasRelevant: ({ context }) => context.relevant.length > 0,
    canRetry: ({ context }) => context.attempt < MAX_ATTEMPTS,
    canRegenerate: ({ context }) => context.regenerations < MAX_REGENERATIONS,
  },
  // A grader's verdict is read INLINE (`event.output.pass`) rather than through
  // a named guard: a guard in `setup` is typed against the machine's whole event
  // union, so it cannot see that this particular transition is a done-event.
}).createMachine({
  id: "correctiveRag",
  initial: "retrieve",
  context: ({ input }) => ({
    generate: input.generate,
    question: input.question,
    query: input.question,
    rewrites: 0,
    steps: [],
    docs: [],
    answer: null,
    grounded: null,
    useful: null,
    exhausted: false,
    attempt: 1,
    regenerations: 0,
    retrieved: [],
    relevant: [],
  }),
  states: {
    /**
     * Retrieval is LEXICAL and synchronous (`shared.ts`), so it is an entry
     * action rather than an invoked actor — there is nothing to await.
     */
    retrieve: {
      entry: [
        // Assigned ONCE and read from context by everything downstream: the
        // grader's input, the relevance filter and the trace all have to be
        // talking about the same retrieval, and calling `retrieve` again per
        // reader is how they come to disagree.
        assign({
          retrieved: ({ context }) => retrieve(context.query).map((one) => one.doc),
          relevant: () => [],
          docs: () => [],
        }),
        // Actions run in order and an `assign` is visible to the next one, so
        // this reads the retrieval above rather than redoing it.
        noteFrom("retrieve", (ctx) => `${ctx.retrieved.length} document(s) for "${ctx.query}"`),
      ],
      always: "gradeDocuments",
    },

    gradeDocuments: {
      invoke: {
        src: "gradeDocuments",
        input: ({ context }) => ({ ctx: context, docs: context.retrieved }),
        onDone: {
          target: "decideToGenerate",
          actions: [
            assign({
              docs: ({ event }) => event.output,
              relevant: ({ context, event }) =>
                context.retrieved.filter(
                  (doc) => event.output.find((graded) => graded.id === doc.id)?.relevant,
                ),
            }),
            noteFrom(
              "grade_documents",
              (ctx) => `${ctx.relevant.length} of ${ctx.docs.length} relevant`,
            ),
          ],
        },
      },
    },

    /**
     * Nothing relevant means the RETRIEVAL was wrong, not that the answer is
     * unknown — so rewrite and try again before giving up. Pure routing: three
     * guarded edges and no work of its own.
     */
    decideToGenerate: {
      always: [
        { guard: "hasRelevant", target: "generate" },
        { guard: "canRetry", target: "transformQuery" },
        {
          target: "exhausted",
          actions: [
            assign({ exhausted: () => true }),
            noteAt("decide_to_generate", "no relevant documents, and no attempts left"),
          ],
        },
      ],
    },

    generate: {
      invoke: {
        src: "generateAnswer",
        input: ({ context }) => ({ ctx: context }),
        onDone: {
          target: "gradeGrounded",
          actions: [
            assign({ answer: ({ event }) => event.output }),
            noteFrom("generate", (ctx) =>
              ctx.regenerations > 0
                ? "regenerated"
                : `answered from ${ctx.relevant.map((doc) => doc.id).join(", ")}`,
            ),
          ],
        },
      },
    },

    /**
     * Is it grounded? A regeneration is worth one shot — the same documents,
     * asked again. Two answers the grader rejected is a signal about the
     * DOCUMENTS rather than about the phrasing, so the second refusal is final
     * and the answer is withheld: an ungrounded answer is never spoken.
     */
    gradeGrounded: {
      invoke: {
        src: "gradeGrounded",
        input: ({ context }) => ({ ctx: context }),
        onDone: [
          {
            guard: ({ event }) => event.output.pass,
            target: "gradeUseful",
            actions: [
              assign({ grounded: () => true }),
              noteAt("grade_generation_v_documents", "grounded"),
            ],
          },
          {
            guard: "canRegenerate",
            target: "generate",
            actions: [
              noteAt("grade_generation_v_documents", "not grounded"),
              assign({ regenerations: ({ context }) => context.regenerations + 1 }),
            ],
          },
          {
            target: "ungrounded",
            actions: [
              assign({ grounded: () => false, answer: () => null, exhausted: () => true }),
              noteAt("grade_generation_v_documents", "still not grounded"),
            ],
          },
        ],
      },
    },

    /**
     * Grounded is not the same as useful. A beside-the-point answer is rewritten
     * once and, out of attempts, RETURNED with its verdict — it is still true,
     * and the tool tells the model to offer a ticket alongside it.
     */
    gradeUseful: {
      invoke: {
        src: "gradeUseful",
        input: ({ context }) => ({ ctx: context }),
        onDone: [
          {
            guard: ({ event }) => event.output.pass,
            target: "done",
            actions: [
              assign({ useful: () => true }),
              noteAt("grade_generation_v_question", "useful"),
            ],
          },
          {
            guard: "canRetry",
            target: "transformQuery",
            actions: [
              assign({ useful: () => false }),
              noteAt("grade_generation_v_question", "not useful"),
            ],
          },
          {
            target: "exhausted",
            actions: [
              assign({ useful: () => false, exhausted: () => true }),
              noteAt("grade_generation_v_question", "not useful, and no attempts left"),
            ],
          },
        ],
      },
    },

    /**
     * The corrective edge. It resets the attempt's verdicts as well as its
     * counters: a rewrite reopens the question, so an answer graded against the
     * OLD query must not survive into the new attempt's trace.
     */
    transformQuery: {
      invoke: {
        src: "transformQuery",
        input: ({ context }) => ({ ctx: context }),
        onDone: {
          target: "retrieve",
          actions: [
            assign({
              query: ({ event }) => event.output,
              rewrites: ({ context }) => context.rewrites + 1,
              attempt: ({ context }) => context.attempt + 1,
              regenerations: () => 0,
              answer: () => null,
              grounded: () => null,
              useful: () => null,
            }),
            noteFrom("transform_query", (ctx) => `retrying as "${ctx.query}"`),
          ],
        },
      },
    },

    done: { type: "final" },
    exhausted: { type: "final" },
    ungrounded: { type: "final" },
  },
  output: ({ context }) => ({
    question: context.question,
    query: context.query,
    rewrites: context.rewrites,
    steps: context.steps,
    docs: context.docs,
    answer: context.answer,
    grounded: context.grounded,
    useful: context.useful,
    exhausted: context.exhausted,
  }),
});

/**
 * Run the graph for one caller question.
 *
 * Never throws for a bad ANSWER — every way of failing to answer is a final
 * STATE, and the trace says which one. A broken model call is different and does
 * throw: an invoked actor's rejection has no `onError` here, so it stops the
 * machine and `toPromise` rejects, which is the tool's to report.
 */
export async function runCorrectiveRag(
  generate: GenerateFn,
  question: string,
): Promise<AnswerTrace> {
  const actor = createActor(machine, { input: { generate, question } });
  actor.start();
  return await toPromise(actor);
}
