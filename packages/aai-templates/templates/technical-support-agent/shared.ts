/**
 * The session's state, the slot, and what the browser is shown.
 *
 * The knowledge base and its retriever moved to `knowledge.ts` so that
 * `client.tsx`, which imports this module for its view, does not take the
 * articles with it.
 */

import { type DeepReadonly, type SlotCaps, sessionSlot } from "@alexkroman1/aai";
import { product } from "./knowledge.json" with { type: "json" };

/**
 * The product this desk supports.
 *
 * A NAMED import off `knowledge.json`, not a property of the whole object: the
 * browser imports this module and must not take `docs` with it. `knowledge.ts`
 * holds the articles.
 */
export const PRODUCT: string = product;

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

const EMPTY_SUPPORT: SupportState = { trace: null, asked: [], ticket: null, ticketCounter: 0 };

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

/** What the browser sees. */
export interface SupportView {
  product: string;
  trace: DeepReadonly<AnswerTrace> | null;
  asked: readonly string[];
  /** The reference only — the callback number stays on the server. */
  ticket: string | null;
}

/**
 * The call's state, and the `view` synced to the page. The `ticket` field is why
 * that is a projection rather than the state itself: a ticket carries the
 * caller's phone number, and the view is where you decide what leaves the
 * server.
 */
export const supportSlot = sessionSlot("support", EMPTY_SUPPORT, {
  // The trace, synced to the page after every tool call. The projection is
  // also the privacy boundary: a logged ticket carries the caller's callback
  // number, and only its reference crosses to the browser.
  sync: true,
  view: (state): SupportView => ({
    product: PRODUCT,
    trace: state.trace,
    asked: state.asked,
    ticket: state.ticket?.reference ?? null,
  }),
  caps,
});
