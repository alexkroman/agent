// Copyright 2025 the AAI authors. MIT license.
/**
 * In-memory Vector implementation.
 *
 * INTENTIONALLY BAD QUALITY. Pseudo-embedding hashes the text into a
 * 64-dim Float32Array of values in [-1, 1]; cosine similarity falls
 * out of that. Used only for `aai dev` and tests — the goal is
 * proving tool wiring, not retrieval ranking.
 */

import { createHash } from "node:crypto";
import type { Vector, VectorMatch, VectorQueryOptions } from "../sdk/vector.ts";

export type MemoryVectorOptions = {
  namespace: string;
};

type Record_ = {
  text: string;
  metadata: Record<string, unknown> | undefined;
  vec: Float32Array;
};

const stores = new Map<string, Map<string, Record_>>();

function getStore(ns: string): Map<string, Record_> {
  let store = stores.get(ns);
  if (!store) {
    store = new Map();
    stores.set(ns, store);
  }
  return store;
}

const DIM = 64;

function pseudoEmbed(text: string): Float32Array {
  const out = new Float32Array(DIM);
  const h1 = createHash("sha256").update(text).digest();
  const h2 = createHash("sha256").update(h1).digest();
  for (let i = 0; i < 32; i++) out[i] = ((h1[i] as number) - 128) / 128;
  for (let i = 0; i < 32; i++) out[i + 32] = ((h2[i] as number) - 128) / 128;
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += (out[i] as number) * (out[i] as number);
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) out[i] = (out[i] as number) / norm;
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < DIM; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

function matches(
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, want] of Object.entries(filter)) {
    if (want !== null && typeof want === "object") {
      throw new Error(
        `In-memory Vector: filter operator unsupported (${key}). Only top-level exact-match is supported.`,
      );
    }
    if (metadata?.[key] !== want) return false;
  }
  return true;
}

export function createMemoryVector(opts: MemoryVectorOptions): Vector {
  const ns = opts.namespace;

  return {
    async upsert(id, text, metadata) {
      getStore(ns).set(id, { text, metadata, vec: pseudoEmbed(text) });
    },
    async query(text, queryOpts?: VectorQueryOptions) {
      const topK = queryOpts?.topK ?? 5;
      const filter = queryOpts?.filter;
      const probe = pseudoEmbed(text);
      const scored: VectorMatch[] = [];
      for (const [id, rec] of getStore(ns)) {
        if (filter && !matches(rec.metadata, filter)) continue;
        scored.push({
          id,
          score: cosine(probe, rec.vec),
          text: rec.text,
          ...(rec.metadata !== undefined ? { metadata: rec.metadata } : {}),
        });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    },
    async delete(ids) {
      const store = getStore(ns);
      const list = Array.isArray(ids) ? ids : [ids];
      for (const id of list) store.delete(id);
    },
  };
}

/** Test-only: clear all in-memory state. Not exported from the package. */
export function _resetMemoryVectorForTests(): void {
  stores.clear();
}
