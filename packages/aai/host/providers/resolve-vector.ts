// Copyright 2025 the AAI authors. MIT license.

import { IN_MEMORY_VECTOR_KIND } from "../../sdk/providers/vector/in-memory.ts";
import {
  PINECONE_API_KEY_ENV,
  PINECONE_VECTOR_KIND,
  type PineconeOptions,
} from "../../sdk/providers/vector/pinecone.ts";
import type { VectorProvider } from "../../sdk/providers.ts";
import type { Vector } from "../../sdk/vector.ts";
import { createMemoryVector } from "../memory-vector.ts";
import { createPineconeVector } from "../pinecone-vector.ts";
import { requireApiKey } from "./_utils.ts";

export function resolveVector(
  descriptor: VectorProvider,
  env: Record<string, string>,
  namespace: string,
): Vector {
  switch (descriptor.kind) {
    case IN_MEMORY_VECTOR_KIND:
      return createMemoryVector({ namespace });
    case PINECONE_VECTOR_KIND: {
      // Reads the agent env only — never process.env (see the credential
      // separation notes on resolveApiKey).
      const apiKey = requireApiKey(
        env[PINECONE_API_KEY_ENV],
        PINECONE_API_KEY_ENV,
        "Pinecone Vector",
        (msg) => new Error(msg),
      );
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
