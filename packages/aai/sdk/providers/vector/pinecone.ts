// Copyright 2025 the AAI authors. MIT license.
/**
 * Pinecone Vector descriptor.
 *
 * The descriptor flows through bundle → server → runtime without
 * importing `@pinecone-database/pinecone`. The host-side resolver in
 * `host/providers/resolve-vector.ts` constructs a real client during
 * `createRuntime`, using `PINECONE_API_KEY` from the agent's env.
 */

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

export function pinecone(opts: PineconeOptions): PineconeProvider {
  return { kind: PINECONE_VECTOR_KIND, options: { ...opts } };
}
