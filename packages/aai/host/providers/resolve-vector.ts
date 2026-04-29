// Copyright 2025 the AAI authors. MIT license.

import { IN_MEMORY_VECTOR_KIND } from "../../sdk/providers/vector/in-memory.ts";
import { PINECONE_VECTOR_KIND, type PineconeOptions } from "../../sdk/providers/vector/pinecone.ts";
import type { VectorProvider } from "../../sdk/providers.ts";
import type { Vector } from "../../sdk/vector.ts";
import { createMemoryVector } from "../memory-vector.ts";
import { createPineconeVector } from "../pinecone-vector.ts";
import { resolveApiKey } from "./resolve.ts";

export function resolveVector(
  descriptor: VectorProvider,
  env: Record<string, string>,
  namespace: string,
): Vector {
  switch (descriptor.kind) {
    case IN_MEMORY_VECTOR_KIND:
      return createMemoryVector({ namespace });
    case PINECONE_VECTOR_KIND: {
      const apiKey = resolveApiKey("PINECONE_API_KEY", env);
      if (!apiKey) {
        throw new Error("Pinecone Vector: missing API key. Set PINECONE_API_KEY in the agent env.");
      }
      const { index } = descriptor.options as unknown as PineconeOptions;
      return createPineconeVector({ apiKey, index, namespace });
    }
    default:
      throw new Error(
        `Unknown Vector provider kind: "${descriptor.kind}". ` +
          `Supported: ${IN_MEMORY_VECTOR_KIND}, ${PINECONE_VECTOR_KIND}.`,
      );
  }
}
