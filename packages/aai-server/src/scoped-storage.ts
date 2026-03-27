// Copyright 2025 the AAI authors. MIT license.
// Scoped KV and vector store factories backed by unstorage.

import type { Kv } from "@alexkroman1/aai/kv";
import { createUnstorageKv } from "@alexkroman1/aai/unstorage-kv";
import { createUnstorageVectorStore } from "@alexkroman1/aai/unstorage-vector";
import type { VectorStore } from "@alexkroman1/aai/vector";
import type { Storage } from "unstorage";

/** Create a KV store scoped to a specific agent slug. */
export function createScopedKv(storage: Storage, slug: string): Kv {
  return createUnstorageKv({
    storage,
    prefix: `agents/${slug}/kv`,
  });
}

/** Create a vector store scoped to a specific agent slug. */
export function createScopedVector(storage: Storage, slug: string): VectorStore {
  return createUnstorageVectorStore({
    storage,
    blobKey: `agents/${slug}/vectors.json`,
  });
}
