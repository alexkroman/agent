// Copyright 2025 the AAI authors. MIT license.
/** Pinecone Vector descriptor — no `@pinecone-database/pinecone` import needed here. */

import type { VectorProvider } from "../../providers.ts";

export const PINECONE_VECTOR_KIND = "pinecone" as const;

export interface PineconeOptions {
  /** Pinecone index name. The index must be created with integrated-inference embed config. */
  index: string;
}

export type PineconeProvider = VectorProvider & {
  readonly kind: typeof PINECONE_VECTOR_KIND;
  readonly options: PineconeOptions;
};

/**
 * Use a Pinecone index for vector storage.
 *
 * No API key is accepted here — the host-side runtime reads
 * `PINECONE_API_KEY` from the agent's env at session start.
 */
export function pinecone(opts: PineconeOptions): PineconeProvider {
  return { kind: PINECONE_VECTOR_KIND, options: { ...opts } };
}
