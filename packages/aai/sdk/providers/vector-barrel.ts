// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/vector` subpath barrel.
 *
 * Re-exports descriptor factories. Importing this barrel does not
 * pull in `@pinecone-database/pinecone` — the host resolver handles
 * that at session start.
 */

export type { VectorProvider } from "../providers.ts";
export type { Vector, VectorMatch, VectorQueryOptions } from "../vector.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./vector/in-memory.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./vector/pinecone.ts";
