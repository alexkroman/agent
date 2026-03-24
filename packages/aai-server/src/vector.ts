// Copyright 2025 the AAI authors. MIT license.
// Vector store backed by Upstash Vector REST API using raw fetch().

import type { VectorEntry } from "@alexkroman1/aai/vector";
import type { AgentScope } from "./scope_token.ts";

export type ServerVectorStore = {
  upsert(
    scope: AgentScope,
    id: string,
    data: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  query(scope: AgentScope, text: string, topK?: number, filter?: string): Promise<VectorEntry[]>;
  remove(scope: AgentScope, ids: string[]): Promise<void>;
};

function namespace(scope: AgentScope): string {
  return `${scope.keyHash}:${scope.slug}`;
}

type VectorResponse = { result: unknown; error?: string };

async function vectorFetch(
  url: string,
  token: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${url}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Upstash Vector error: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as VectorResponse;
  if (json.error) throw new Error(`Upstash Vector: ${json.error}`);
  return json.result;
}

type QueryResult = {
  id: string | number;
  score: number;
  data?: string;
  metadata?: Record<string, unknown>;
};

export function createVectorStore(url: string, token: string): ServerVectorStore {
  return {
    async upsert(scope, id, data, metadata) {
      const ns = namespace(scope);
      await vectorFetch(url, token, `upsert/${ns}`, [{ id, data, metadata }]);
    },

    async query(scope, text, topK = 10, filter?) {
      const ns = namespace(scope);
      const results = (await vectorFetch(url, token, `query/${ns}`, {
        data: text,
        topK,
        includeData: true,
        includeMetadata: true,
        ...(filter ? { filter } : {}),
      })) as QueryResult[];
      return results.map((r) => ({
        id: String(r.id),
        score: r.score,
        data: r.data as string | undefined,
        metadata: r.metadata as Record<string, unknown> | undefined,
      }));
    },

    async remove(scope, ids) {
      const ns = namespace(scope);
      await vectorFetch(url, token, `delete/${ns}`, ids);
    },
  };
}
