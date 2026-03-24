// Copyright 2025 the AAI authors. MIT license.
/**
 * AaiVectorizeIndex implementation backed by @upstash/vector.
 *
 * @module
 */

import { Index } from "@upstash/vector";
import type { AaiVectorizeIndex, AaiVectorizeMatch } from "./bindings.ts";

export type VectorizeConfig = {
  url: string;
  token: string;
};

export function createVectorizeBinding(config: VectorizeConfig): AaiVectorizeIndex {
  const index = new Index({ url: config.url, token: config.token });

  return {
    async upsert(vectors) {
      for (const v of vectors) {
        if (v.values) {
          await index.upsert({ id: v.id, vector: v.values, metadata: v.metadata });
        } else {
          await index.upsert({ id: v.id, data: "", metadata: v.metadata });
        }
      }
      return { count: vectors.length };
    },

    async query(queryVector, options) {
      const results = await index.query({
        ...(typeof queryVector === "string" ? { data: queryVector } : { vector: queryVector }),
        topK: options?.topK ?? 10,
        includeMetadata: options?.returnMetadata ?? true,
        ...(options?.filter ? { filter: String(options.filter) } : {}),
      });
      const matches: AaiVectorizeMatch[] = results.map((r) => ({
        id: String(r.id),
        score: r.score,
        metadata: r.metadata as Record<string, unknown> | undefined,
      }));
      return { matches };
    },

    async deleteByIds(ids) {
      await index.delete(ids);
      return { count: ids.length };
    },
  };
}
