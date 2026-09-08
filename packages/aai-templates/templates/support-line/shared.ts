/**
 * The knowledge base, the retriever, and what the browser is shown.
 *
 * **The retriever is lexical, and that is a deliberate difference from the
 * notebooks this template ports.** Their self-RAG and CRAG graphs retrieve from
 * a Chroma vectorstore over OpenAI embeddings; this SDK has no vector store
 * (`ctx.vector` was removed — see the root guide), and a template that needed
 * one would be a template nobody can run. So retrieval here is term overlap
 * with an inverse-document-frequency weight, which is genuinely worse at
 * meaning and genuinely fine at words.
 *
 * That makes the corrective loop MORE valuable rather than less, which is the
 * point worth taking away: CRAG exists because retrieval is imperfect, and a
 * weaker retriever is exactly the case its grader and its query rewriter were
 * designed for. A caller saying "my internet keeps dying at night" retrieves
 * nothing useful by words alone — the rewrite step is what turns it into
 * "evening slowdown congestion peak time" and finds D10.
 */

import {
  type DeepReadonly,
  type SlotCaps,
  type StateProjection,
  sessionSlot,
} from "@alexkroman1/aai";
import knowledge from "./knowledge.json" with { type: "json" };

export interface Doc {
  id: string;
  title: string;
  topic: string;
  text: string;
}

export const PRODUCT: string = knowledge.product;
export const DOCS: Doc[] = knowledge.docs;

export const TOPICS: string[] = [...new Set(DOCS.map((doc) => doc.topic))].sort();

// ─── Retrieval ───────────────────────────────────────────────────────────────

/** Words that match everything and therefore rank nothing. */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "you",
  "your",
  "are",
  "was",
  "with",
  "that",
  "this",
  "have",
  "has",
  "can",
  "not",
  "but",
  "how",
  "why",
  "what",
  "when",
  "will",
  "from",
  "into",
  "out",
  "get",
  "does",
  "did",
  "any",
  "all",
  "our",
  "their",
  "there",
  "then",
  "than",
  "about",
  "just",
  "been",
  "were",
  "they",
  "them",
  "his",
  "her",
  "its",
  "one",
  "two",
  "who",
  "whom",
  "some",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Term → how many documents contain it, and per document, term → how often it
 * occurs. Both computed once at module load, in the one pass that has to visit
 * every token anyway.
 *
 * The per-document COUNTS are what scoring needs. Keeping the raw token list
 * instead made `retrieve` walk it end to end once per query term, allocating a
 * filtered array each time, to recover a number this loop already had.
 */
const DOC_FREQUENCY = new Map<string, number>();
const DOC_TERM_COUNTS = new Map<string, Map<string, number>>();
for (const doc of DOCS) {
  const counts = new Map<string, number>();
  for (const token of tokenize(`${doc.title} ${doc.topic} ${doc.text}`)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  DOC_TERM_COUNTS.set(doc.id, counts);
  for (const term of counts.keys()) {
    DOC_FREQUENCY.set(term, (DOC_FREQUENCY.get(term) ?? 0) + 1);
  }
}

/** How many documents one retrieval returns before grading. */
export const RETRIEVE_K = 4;

export interface Retrieved {
  doc: Doc;
  score: number;
}

/**
 * The `retrieve` node: top-k by idf-weighted term overlap.
 *
 * A term in one document is worth much more than a term in eight — without the
 * weight, "fibre" and "hub" (in nearly every document) drown the one word that
 * actually distinguishes the caller's question.
 */
export function retrieve(query: string, k: number = RETRIEVE_K): Retrieved[] {
  const terms = new Set(tokenize(query));
  if (terms.size === 0) return [];
  const scored: Retrieved[] = [];
  for (const doc of DOCS) {
    const counts = DOC_TERM_COUNTS.get(doc.id);
    let score = 0;
    for (const term of terms) {
      const hits = counts?.get(term) ?? 0;
      if (hits === 0) continue;
      const frequency = DOC_FREQUENCY.get(term) ?? 1;
      // Diminishing returns per repeat, so one long document cannot win on
      // repetition alone.
      score += Math.log(1 + hits) * Math.log(DOCS.length / frequency + 1);
    }
    if (score > 0) scored.push({ doc, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

/** One document as the answer prompt sees it. */
export function formatDoc(doc: Doc): string {
  return `[${doc.id}] ${doc.title}\n${doc.text}`;
}

// ─── The trace ───────────────────────────────────────────────────────────────
// Their graph is watched by streaming node names to a notebook. A caller hears
// none of that, so the run records itself and the browser renders it.

export interface GradedDoc {
  id: string;
  title: string;
  relevant: boolean;
  reason: string;
}

export interface TraceStep {
  /** The node's name, spelled as their graph spells it. */
  node: string;
  detail: string;
}

export interface AnswerTrace {
  question: string;
  /** The query retrieval actually ran on — rewritten, if it was. */
  query: string;
  rewrites: number;
  steps: TraceStep[];
  docs: GradedDoc[];
  answer: string | null;
  /** `null` until the hallucination grader has run. */
  grounded: boolean | null;
  /** `null` until the answer grader has run. */
  useful: boolean | null;
  /** True when the loop gave up and the caller should be offered a ticket. */
  exhausted: boolean;
}

export interface Ticket {
  reference: string;
  question: string;
  /** Server-side only — the projection never carries it. */
  callback: string;
}

export interface SupportState {
  /** The most recent run, which is what the sidebar renders. */
  trace: AnswerTrace | null;
  /** Every question this call has asked, capped. */
  asked: string[];
  ticket: Ticket | null;
  ticketCounter: number;
}

export function emptySupportState(): SupportState {
  return { trace: null, asked: [], ticket: null, ticketCounter: 0 };
}

/**
 * How many of this call's questions the slot keeps.
 *
 * Exported because a spec reads it — the bound is declared once, here, and the
 * test that the twenty-first question drops the first must not restate the
 * number.
 */
export const ASKED_CAP = 20;

/**
 * The growth bound, named and TYPED.
 *
 * `SlotCaps<SupportState>` admits only the state's array-valued keys, so a cap
 * on `ticketCounter` or a mistyped `askedd` is a compile error at the
 * declaration rather than a bound that silently caps nothing. `asked` rides in
 * every `syncState` frame, which is why it is the field that needs one.
 */
const caps: SlotCaps<SupportState> = { asked: ASKED_CAP };

export const supportSlot = sessionSlot("support", emptySupportState, { caps });

/**
 * The call as a READ hands it out: deep-frozen, and typed to say so.
 *
 * {@link supportView} takes this rather than {@link SupportState}, which is the
 * widening a deep-readonly slot forces and the reason it is worth doing: a
 * mutable state still satisfies it, so a call with an `update` draft is
 * unaffected, while a projection that WOULD have mutated stops compiling
 * instead of throwing at its first call.
 */
export type FrozenSupportState = DeepReadonly<SupportState>;

// ─── The projection ──────────────────────────────────────────────────────────

export interface SupportView {
  product: string;
  trace: DeepReadonly<AnswerTrace> | null;
  asked: readonly string[];
  /** The reference only — the callback number stays on the server. */
  ticket: string | null;
}

/**
 * What the browser sees. The `ticket` field is why this is a projection rather
 * than the state itself: a ticket carries the caller's phone number, and
 * `syncState` is where you decide what leaves the server.
 */
export function supportView(state: FrozenSupportState): SupportView {
  return {
    product: PRODUCT,
    trace: state.trace,
    asked: state.asked,
    ticket: state.ticket?.reference ?? null,
  };
}

/**
 * The projection BOTH ends use: `syncState` on the agent, `useAgentState` in
 * the client.
 *
 * Annotated with `StateProjection<SupportView>` because this export IS the
 * contract between the two — it is the only thing `agent.ts` and `client.tsx`
 * share, and naming what a projection is (a callable carrying the slot's `key`
 * and `create`) is what tells a reader why passing it to `useAgentState`
 * derives the pre-first-frame value for free.
 */
export const supportProjection: StateProjection<SupportView> = supportSlot.projection(supportView);
