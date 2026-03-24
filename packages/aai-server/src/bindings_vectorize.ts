// Copyright 2025 the AAI authors. MIT license.
/**
 * AaiVectorizeIndex implementation backed by Upstash Vector REST API.
 *
 * @module
 */

import type { AaiVectorizeIndex, AaiVectorizeMatch } from "./bindings.ts";

export type VectorizeConfig = {
  url: string;
  token: string;
};

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
  if (!res.ok) throw new Error(`Vectorize error: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as VectorResponse;
  if (json.error) throw new Error(`Vectorize: ${json.error}`);
  return json.result;
}

export function createVectorizeBinding(config: VectorizeConfig): AaiVectorizeIndex {
  const { url, token } = config;

  return {
    async upsert(vectors) {
      const body = vectors.map((v) => ({
        id: v.id,
        ...(v.values ? { vector: v.values } : {}),
        ...(v.metadata ? { metadata: v.metadata } : {}),
      }));
      await vectorFetch(url, token, "upsert", body);
      return { count: vectors.length };
    },

    async query(queryVector, options) {
      const body = {
        ...(typeof queryVector === "string" ? { data: queryVector } : { vector: queryVector }),
        topK: options?.topK ?? 10,
        includeMetadata: options?.returnMetadata ?? true,
        ...(options?.filter ? { filter: options.filter } : {}),
      };
      const results = (await vectorFetch(url, token, "query", body)) as {
        id: string | number;
        score: number;
        metadata?: Record<string, unknown>;
      }[];
      const matches: AaiVectorizeMatch[] = results.map((r) => ({
        id: String(r.id),
        score: r.score,
        metadata: r.metadata,
      }));
      return { matches };
    },

    async deleteByIds(ids) {
      await vectorFetch(url, token, "delete", ids);
      return { count: ids.length };
    },
  };
}
