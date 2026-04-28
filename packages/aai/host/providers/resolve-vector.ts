// Copyright 2025 the AAI authors. MIT license.
/**
 * Descriptor → concrete `Vector` resolver. Mirror of `resolveLlm`.
 *
 * Pulls API keys from the agent env so descriptors stay
 * secret-free. Lazy-loads provider SDKs via `createRequire` so
 * unused providers never enter the bundle.
 */

import {
  IN_MEMORY_VECTOR_KIND,
  type InMemoryVectorOptions,
} from "../../sdk/providers/vector/in-memory.ts";
import { PINECONE_VECTOR_KIND, type PineconeOptions } from "../../sdk/providers/vector/pinecone.ts";
import type { VectorProvider } from "../../sdk/providers.ts";
import type { Vector } from "../../sdk/vector.ts";
import { createMemoryVector } from "../memory-vector.ts";
import { createPineconeVector } from "../pinecone-vector.ts";
import { resolveApiKey } from "./resolve.ts";

/** Resolve a {@link VectorProvider} descriptor into a {@link Vector}. */
export function resolveVector(
  descriptor: VectorProvider,
  env: Record<string, string>,
  namespace: string,
): Vector {
  switch (descriptor.kind) {
    case IN_MEMORY_VECTOR_KIND: {
      void (descriptor.options as unknown as InMemoryVectorOptions);
      return createMemoryVector({ namespace });
    }
    case PINECONE_VECTOR_KIND: {
      const apiKey = resolveApiKey("PINECONE_API_KEY", env);
      if (!apiKey) {
        throw new Error("Pinecone Vector: missing API key. Set PINECONE_API_KEY in the agent env.");
      }
      const opts = descriptor.options as unknown as PineconeOptions;
      return createPineconeVector({ apiKey, index: opts.index, namespace });
    }
    default:
      throw new Error(
        `Unknown Vector provider kind: "${descriptor.kind}". ` +
          `Supported: ${IN_MEMORY_VECTOR_KIND}, ${PINECONE_VECTOR_KIND}.`,
      );
  }
}
