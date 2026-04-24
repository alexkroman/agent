// Copyright 2026 the AAI authors. MIT license.
/**
 * Pinecone vector opener — wraps `@pinecone-database/pinecone` into a
 * provider-agnostic {@link Vector}. The Pinecone SDK is loaded lazily via a
 * synchronous `require` so the runtime resolver stays synchronous.
 *
 * The agent's API key is read from descriptor options or env
 * (`PINECONE_API_KEY`).
 */

import { createRequire } from "node:module";
import type { PineconeOptions } from "../../../sdk/providers/vector/pinecone.ts";
import type { Vector, VectorMatch, VectorQuery, VectorRecord } from "../../../sdk/vector.ts";
import { resolveApiKey } from "../_api-key.ts";

const requireFn = createRequire(import.meta.url);

type PineconeNamespace = {
  upsert(records: PineconeVectorRecord[]): Promise<unknown>;
  query(query: PineconeQuery): Promise<{ matches?: PineconeMatch[] }>;
  deleteMany(ids: string[]): Promise<unknown>;
  deleteAll(): Promise<unknown>;
  fetch(ids: string[]): Promise<{ records?: Record<string, PineconeFetchedRecord> }>;
};

type PineconeVectorRecord = {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
};

type PineconeQuery = {
  topK: number;
  vector?: number[];
  id?: string;
  filter?: Record<string, unknown>;
  includeValues?: boolean;
  includeMetadata?: boolean;
};

type PineconeMatch = {
  id: string;
  score?: number;
  values?: number[];
  metadata?: Record<string, unknown>;
};

type PineconeFetchedRecord = {
  id: string;
  values?: number[];
  metadata?: Record<string, unknown>;
};

type PineconeIndex = {
  upsert(records: PineconeVectorRecord[]): Promise<unknown>;
  query(query: PineconeQuery): Promise<{ matches?: PineconeMatch[] }>;
  deleteMany(ids: string[]): Promise<unknown>;
  deleteAll(): Promise<unknown>;
  fetch(ids: string[]): Promise<{ records?: Record<string, PineconeFetchedRecord> }>;
  namespace(ns: string): PineconeNamespace;
};

type PineconeClient = {
  index(name: string, indexHostUrl?: string): PineconeIndex;
};

type PineconeCtor = new (config: { apiKey: string }) => PineconeClient;

function loadPineconeSdk(): PineconeCtor {
  try {
    const mod = requireFn("@pinecone-database/pinecone") as { Pinecone?: PineconeCtor };
    if (!mod.Pinecone) {
      throw new Error("@pinecone-database/pinecone did not export `Pinecone`");
    }
    return mod.Pinecone;
  } catch (err) {
    throw new Error(
      `Pinecone provider requires the optional peer dependency "@pinecone-database/pinecone". Install it: pnpm add @pinecone-database/pinecone — ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}

export function openPineconeVector(opts: PineconeOptions, env: Record<string, string>): Vector {
  const apiKey = opts.apiKey ?? resolveApiKey("PINECONE_API_KEY", env);
  if (!apiKey) {
    throw new Error(
      "Pinecone: missing API key. Set PINECONE_API_KEY or pass apiKey to pinecone({...}).",
    );
  }
  const Pinecone = loadPineconeSdk();
  const client = new Pinecone({ apiKey });
  const indexHandle = opts.indexHost
    ? client.index(opts.index, opts.indexHost)
    : client.index(opts.index);

  function pickHandle(namespace?: string): PineconeIndex | PineconeNamespace {
    const ns = namespace ?? opts.namespace;
    return ns ? indexHandle.namespace(ns) : indexHandle;
  }

  function toMatch(m: PineconeMatch): VectorMatch {
    const out: VectorMatch = { id: m.id, score: m.score ?? 0 };
    if (m.metadata !== undefined) out.metadata = m.metadata;
    if (m.values !== undefined) out.values = m.values;
    return out;
  }

  return {
    async upsert(records, options) {
      const arr = Array.isArray(records) ? records : [records];
      const handle = pickHandle(options?.namespace);
      await handle.upsert(
        arr.map((r) => ({
          id: r.id,
          values: r.values,
          ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
        })),
      );
    },

    async query(query: VectorQuery): Promise<VectorMatch[]> {
      const handle = pickHandle(query.namespace);
      const pineconeQuery: PineconeQuery = { topK: query.topK ?? 10 };
      if (query.vector !== undefined) pineconeQuery.vector = query.vector;
      if (query.id !== undefined) pineconeQuery.id = query.id;
      if (query.filter !== undefined) pineconeQuery.filter = query.filter;
      if (query.includeValues !== undefined) pineconeQuery.includeValues = query.includeValues;
      if (query.includeMetadata !== undefined)
        pineconeQuery.includeMetadata = query.includeMetadata;
      const result = await handle.query(pineconeQuery);
      return (result.matches ?? []).map(toMatch);
    },

    async delete(ids, options) {
      const handle = pickHandle(options?.namespace);
      if (options?.deleteAll) {
        await handle.deleteAll();
        return;
      }
      const arr = Array.isArray(ids) ? ids : [ids];
      if (arr.length === 0) return;
      await handle.deleteMany(arr);
    },

    async fetch(ids, options): Promise<VectorRecord[]> {
      const handle = pickHandle(options?.namespace);
      const arr = Array.isArray(ids) ? ids : [ids];
      if (arr.length === 0) return [];
      const result = await handle.fetch(arr);
      const records = result.records ?? {};
      return Object.values(records).map((r) => ({
        id: r.id,
        values: r.values ?? [],
        ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
      }));
    },
  };
}
