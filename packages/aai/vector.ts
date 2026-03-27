// Copyright 2025 the AAI authors. MIT license.
/**
 * Vector store interface.
 */

/**
 * Maximum allowed length for a vector filter expression.
 * @internal
 */
const MAX_FILTER_LENGTH = 1000;

/**
 * SQL/query keywords that must not appear in filter expressions.
 * Checked case-insensitively as whole words (word-boundary match).
 * @internal
 */
const DANGEROUS_KEYWORDS =
  /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|EXECUTE|UNION|INTO|TRUNCATE|GRANT|REVOKE|CALL)\b/i;

/**
 * Patterns that indicate injection attempts in filter strings.
 * @internal
 */
const DANGEROUS_PATTERNS = [
  /;/, // statement terminators
  /--/, // SQL line comments
  /\/\*/, // block comment open
  /\*\//, // block comment close
  /\0/, // null bytes
];

/**
 * Validate a vector filter expression to prevent injection attacks.
 *
 * Rejects filters containing SQL keywords (SELECT, DROP, etc.),
 * statement terminators, comments, and null bytes. Enforces a
 * maximum length of 1000 characters.
 *
 * @param filter - The raw filter string from user input.
 * @returns The validated filter string (trimmed).
 * @throws Error if the filter contains dangerous patterns.
 *
 * @public
 */
export function validateVectorFilter(filter: string): string {
  const trimmed = filter.trim();
  if (trimmed.length === 0) {
    throw new Error("Vector filter must not be empty");
  }
  if (trimmed.length > MAX_FILTER_LENGTH) {
    throw new Error(`Vector filter exceeds maximum length of ${MAX_FILTER_LENGTH} characters`);
  }
  if (DANGEROUS_KEYWORDS.test(trimmed)) {
    throw new Error("Vector filter contains disallowed SQL keyword");
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error("Vector filter contains disallowed characters");
    }
  }
  return trimmed;
}

/**
 * A single vector search result entry.
 *
 * @public
 */
export type VectorEntry = {
  /** The unique identifier for this entry. */
  id: string;
  /** Similarity score (higher = more similar). */
  score: number;
  /** The original text data stored with this entry. */
  data?: string | undefined;
  /** Arbitrary metadata stored with this entry. */
  metadata?: Record<string, unknown> | undefined;
};

/**
 * Async vector store interface used by agents.
 *
 * Agents access the vector store via `ToolContext.vector` or
 * `HookContext.vector`. Backed by unstorage with local embeddings
 * via `all-MiniLM-L6-v2` by default. Pluggable storage driver and
 * embedding function.
 *
 * @example
 * ```ts
 * // Inside a tool execute function:
 * const myTool = {
 *   description: "Search knowledge base",
 *   execute: async (_args: unknown, ctx: { vector: VectorStore }) => {
 *     await ctx.vector.upsert("doc-1", "The capital of France is Paris.");
 *     const results = await ctx.vector.query("What is the capital of France?");
 *     return results;
 *   },
 * };
 * ```
 *
 * @public
 */
export type VectorStore = {
  /**
   * Upsert a text entry into the vector store.
   *
   * The text is automatically embedded by the server's vector database.
   *
   * @param id - Unique identifier for this entry.
   * @param data - The text content to store and embed.
   * @param metadata - Optional metadata to store alongside the vector.
   */
  upsert(id: string, data: string, metadata?: Record<string, unknown>): Promise<void>;

  /**
   * Query the vector store with a text string.
   *
   * Returns the most similar entries ranked by score.
   *
   * @param text - The query text to search for.
   * @param options - Optional query parameters. `topK` sets the maximum number of results (default: 10). `filter` is a metadata filter expression.
   * @returns An array of matching {@link VectorEntry} objects.
   */
  query(text: string, options?: { topK?: number; filter?: string }): Promise<VectorEntry[]>;

  /**
   * Delete entries by ID.
   *
   * @param ids - A single ID or array of IDs to delete.
   */
  delete(ids: string | string[]): Promise<void>;
};
