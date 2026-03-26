// Copyright 2025 the AAI authors. MIT license.
/**
 * LanceDB-backed vector store with OpenAI embeddings.
 *
 * Persists data across restarts using a local LanceDB directory.
 * Uses OpenAI `text-embedding-3-small` for embeddings by default.
 */

import * as lancedb from "@lancedb/lancedb";
import type { VectorEntry, VectorStore } from "./vector.ts";

/** Function that converts text into an embedding vector. */
export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * Options for creating a LanceDB-backed vector store.
 */
export type LanceDbVectorStoreOptions = {
  /** Path to the LanceDB directory. Defaults to `.aai/lancedb`. */
  path?: string;
  /** OpenAI API key. Defaults to `process.env.OPENAI_API_KEY`. */
  openaiApiKey?: string;
  /** Custom embedding function (overrides OpenAI). Useful for testing. */
  embedFn?: EmbedFn;
  /** Embedding dimensions. Defaults to 1536 (text-embedding-3-small). */
  dimensions?: number;
};

const TABLE_NAME = "vectors";
const DEFAULT_DIMENSIONS = 1536;

/**
 * Create an OpenAI embedding function using `text-embedding-3-small`.
 */
function createOpenAiEmbedFn(apiKey: string): EmbedFn {
  return async (text: string): Promise<number[]> => {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embeddings API error (${res.status}): ${body}`);
    }
    const json = (await res.json()) as {
      data: { embedding: number[] }[];
    };
    const embedding = json.data[0]?.embedding;
    if (!embedding) throw new Error("OpenAI embeddings API returned empty data");
    return embedding;
  };
}

/**
 * Create a deterministic hash-based embedding function for testing.
 *
 * Produces repeatable vectors where similar text yields similar embeddings.
 * Not suitable for production — use OpenAI or another real embedding model.
 *
 * @param dimensions - Vector dimensions (default: 1536).
 */
export function createTestEmbedFn(dimensions = DEFAULT_DIMENSIONS): EmbedFn {
  return async (text: string): Promise<number[]> => {
    const vec = new Float32Array(dimensions);
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      for (let i = 0; i < 8; i++) {
        const idx = Math.abs((hash + i * 31_337) % dimensions);
        vec[idx] = (vec[idx] ?? 0) + 1;
      }
    }
    // Normalize to unit vector
    let norm = 0;
    for (let i = 0; i < dimensions; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
    norm = Math.sqrt(norm) || 1;
    return Array.from(vec, (v) => v / norm);
  };
}

/**
 * Create a LanceDB-backed vector store.
 *
 * Data persists to a local directory (default: `.aai/lancedb`).
 * Uses OpenAI `text-embedding-3-small` for embeddings by default,
 * or a custom `embedFn` for testing.
 *
 * @param options - See {@link LanceDbVectorStoreOptions}.
 * @returns A Promise resolving to a {@link VectorStore} instance.
 *
 * @example
 * ```ts
 * import { createLanceDbVectorStore } from "@alexkroman1/aai/lancedb-vector";
 *
 * const vector = await createLanceDbVectorStore();
 * await vector.upsert("doc-1", "The capital of France is Paris.");
 * const results = await vector.query("France capital");
 * ```
 */
export async function createLanceDbVectorStore(
  options?: LanceDbVectorStoreOptions,
): Promise<VectorStore> {
  const dbPath = options?.path ?? ".aai/lancedb";
  const dimensions = options?.dimensions ?? DEFAULT_DIMENSIONS;

  let embedFn: EmbedFn;
  if (options?.embedFn) {
    embedFn = options.embedFn;
  } else {
    const apiKey = options?.openaiApiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is required for vector store embeddings. " +
          "Set the environment variable or pass openaiApiKey in options.",
      );
    }
    embedFn = createOpenAiEmbedFn(apiKey);
  }

  const db = await lancedb.connect(dbPath);

  // Get or create the table
  const tableNames = await db.tableNames();
  let table: lancedb.Table;
  if (tableNames.includes(TABLE_NAME)) {
    table = await db.openTable(TABLE_NAME);
  } else {
    // Create with a dummy record to define schema, then delete it
    const zeroVec = new Array<number>(dimensions).fill(0);
    table = await db.createTable(TABLE_NAME, [
      { id: "__init__", data: "", metadata: "", vector: zeroVec },
    ]);
    await table.delete('id = "__init__"');
  }

  return {
    async upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void> {
      const vector = await embedFn(data);
      const metaJson = metadata ? JSON.stringify(metadata) : "";
      const record = { id, data, metadata: metaJson, vector };

      // Delete existing record with this ID, then add the new one
      try {
        await table.delete(`id = "${id}"`);
      } catch {
        // Ignore if not found
      }
      await table.add([record]);
    },

    async query(
      text: string,
      options?: { topK?: number; filter?: string },
    ): Promise<VectorEntry[]> {
      const topK = options?.topK ?? 10;
      if (!text.trim()) return [];

      const queryVec = await embedFn(text);

      let search = table.vectorSearch(queryVec).distanceType("cosine").limit(topK);
      if (options?.filter) {
        search = search.where(options.filter);
      }

      const rows: Record<string, unknown>[] = await search.toArray();
      return rows.map((row) => ({
        id: row.id as string,
        score: 1 - (row._distance as number), // cosine distance → similarity
        data: row.data as string,
        metadata:
          row.metadata && (row.metadata as string) !== ""
            ? (JSON.parse(row.metadata as string) as Record<string, unknown>)
            : undefined,
      }));
    },

    async delete(ids: string | string[]): Promise<void> {
      const idArray = Array.isArray(ids) ? ids : [ids];
      for (const id of idArray) {
        try {
          await table.delete(`id = "${id}"`);
        } catch {
          // Ignore if not found
        }
      }
    },
  };
}
