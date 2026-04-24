// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/vector` subpath barrel.
 *
 * Re-exports vector store descriptor factories and shared types. Importing
 * this barrel does not pull in `@pinecone-database/pinecone` — the host
 * resolver handles that when the descriptor is opened.
 */

export type { VectorProvider } from "../providers.ts";
export type { Vector, VectorMatch, VectorQuery, VectorRecord } from "../vector.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./vector/pinecone.ts";
