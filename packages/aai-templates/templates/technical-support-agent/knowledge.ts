// Copyright 2026 the AAI authors. MIT license.
/**
 * The knowledge base and the retriever over it.
 *
 * **Split from `shared.ts` to keep `knowledge.json` out of the browser
 * bundle.** The index below is built at MODULE SCOPE — `for (const doc of
 * DOCS)` runs on import — so every document was reachable from any module that
 * touched this file, and `client.tsx` touches `shared.ts` for its view. Measured
 * before this split: the full text of every article was present in the built
 * client bundle.
 *
 * `shared.ts` keeps `PRODUCT` alone, as a named import off the same JSON, so the
 * browser still derives the tab title from the knowledge base without taking
 * the articles with it. Everything that reads `docs` lives here, and the browser
 * never imports this module.
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
import { docs } from "./knowledge.json" with { type: "json" };

export interface Doc {
  id: string;
  title: string;
  topic: string;
  text: string;
}

export const DOCS: Doc[] = docs;

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
