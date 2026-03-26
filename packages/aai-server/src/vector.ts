// Copyright 2025 the AAI authors. MIT license.
// Vector store backed by @upstash/vector.

import type { VectorEntry } from "@alexkroman1/aai/vector";
import { Index } from "@upstash/vector";
import type { AgentScope } from "./scope-token.ts";

export type ServerVectorStore = {
  upsert(
    scope: AgentScope,
    id: string,
    data: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  query(scope: AgentScope, text: string, topK?: number, filter?: string): Promise<VectorEntry[]>;
  delete(scope: AgentScope, ids: string[]): Promise<void>;
};

function namespace(scope: AgentScope): string {
  return `${scope.keyHash}:${scope.slug}`;
}

export function createVectorStore(url: string, token: string): ServerVectorStore {
  const index = new Index({ url, token });

  return {
    async upsert(scope, id, data, metadata) {
      const ns = namespace(scope);
      await index.upsert({ id, data, metadata }, { namespace: ns });
    },

    async query(scope, text, topK = 10, filter?) {
      const ns = namespace(scope);
      const results = await index.query(
        {
          data: text,
          topK,
          includeData: true,
          includeMetadata: true,
          ...(filter ? { filter } : {}),
        },
        { namespace: ns },
      );
      return results.map((r) => ({
        id: String(r.id),
        score: r.score,
        data: r.data as string | undefined,
        metadata: r.metadata as Record<string, unknown> | undefined,
      }));
    },

    async delete(scope, ids) {
      const ns = namespace(scope);
      await index.delete(ids, { namespace: ns });
    },
  };
}
