// Copyright 2025 the AAI authors. MIT license.
/**
 * Pinecone Vector implementation using integrated inference.
 *
 * The Pinecone index must be created with an embed config (e.g.
 * `multilingual-e5-large`); we never see the embedding vectors.
 *
 * `@pinecone-database/pinecone` is loaded lazily via `createRequire`
 * so the package becomes a true *optional* peer dependency: if a
 * deployment doesn't use Pinecone, the missing package is never
 * imported.
 */

import type { Vector, VectorMatch, VectorQueryOptions } from "../sdk/vector.ts";
import { loadProviderPackage } from "./providers/resolve.ts";

export type PineconeVectorOptions = {
  apiKey: string;
  index: string;
  /** Per-tenant namespace — set by the server to the agent slug. */
  namespace: string;
};

type PineconeNs = {
  upsertRecords: (records: Record<string, unknown>[]) => Promise<unknown>;
  searchRecords: (req: {
    query: { inputs: { text: string }; topK: number; filter?: Record<string, unknown> };
    fields: string[];
  }) => Promise<{
    result: { hits: Array<{ _id: string; _score: number; fields: Record<string, unknown> }> };
  }>;
  deleteMany: (ids: string[]) => Promise<unknown>;
};

type PineconeClient = {
  index: (name: string) => { namespace: (ns: string) => PineconeNs };
};

export function createPineconeVector(opts: PineconeVectorOptions): Vector {
  const { Pinecone } = loadProviderPackage<{
    Pinecone: new (opts: { apiKey: string }) => PineconeClient;
  }>("@pinecone-database/pinecone", "Pinecone Vector");
  const ns = new Pinecone({ apiKey: opts.apiKey }).index(opts.index).namespace(opts.namespace);

  return {
    async upsert(id, text, metadata) {
      await ns.upsertRecords([{ _id: id, text, ...(metadata ?? {}) }]);
    },
    async query(text, queryOpts?: VectorQueryOptions) {
      const { topK = 5, filter } = queryOpts ?? {};
      const resp = await ns.searchRecords({
        query: { inputs: { text }, topK, ...(filter !== undefined ? { filter } : {}) },
        fields: ["*"],
      });
      return resp.result.hits.map((hit): VectorMatch => {
        const { text: hitText, ...rest } = hit.fields;
        const match: VectorMatch = {
          id: hit._id,
          score: hit._score,
          text: typeof hitText === "string" ? hitText : "",
        };
        if (Object.keys(rest).length > 0) match.metadata = rest;
        return match;
      });
    },
    async delete(ids) {
      await ns.deleteMany(Array.isArray(ids) ? ids : [ids]);
    },
  };
}
