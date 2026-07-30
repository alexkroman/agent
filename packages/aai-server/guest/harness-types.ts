// Copyright 2025 the AAI authors. MIT license.
//
// Shared type definitions for the Deno guest harness.
//
// Split out of `deno-harness.ts` to keep that entrypoint focused on the
// dispatch loop. Like the harness, this file has ZERO workspace imports —
// it is bundled into the self-contained guest artifact (and, in dev, loaded
// by Deno as a sibling via a static import, which needs no extra
// permissions).

// ---- Tool / agent shapes ----------------------------------------------------

export type Message = {
  role: "user" | "assistant" | "tool";
  content: string;
};

// Minimal Db-shaped adapter passed to tool contexts (mirrors the SDK's `Db`)
export type DbAdapter = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};

export type VectorMatch = {
  id: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
};

export type VectorQueryOptions = {
  topK?: number;
  filter?: Record<string, unknown>;
};

export type VectorAdapter = {
  upsert(id: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
  query(text: string, opts?: VectorQueryOptions): Promise<VectorMatch[]>;
  delete(ids: string | string[]): Promise<void>;
};

// Mirrors the SDK's GenerateOptions/GenerateResult (sdk/generate.ts) —
// JSON-serializable by design, proxied to the host as the llm/generate RPC.
export type GenerateOptions = {
  prompt: string;
  system?: string;
  llm?: { kind: string; options: Record<string, unknown> };
  schema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
};

export type GenerateResult = {
  text: string;
  object?: unknown;
};

export type GenerateAdapter = (options: GenerateOptions) => Promise<GenerateResult>;

export type ToolContext = {
  env: Readonly<Record<string, string>>;
  state: Record<string, unknown>;
  /** App database. Accessing it with storage disabled throws guidance. */
  db: DbAdapter;
  vector: VectorAdapter;
  generate: GenerateAdapter;
  sessionId: string;
  messages: readonly Message[];
  send(event: string, data: unknown): void;
};

export type ToolDef = {
  description: string;
  parameters?: { parse(args: unknown): unknown };
  execute(args: unknown, ctx: ToolContext): Promise<unknown> | unknown;
};

export type AgentDef = {
  name: string;
  systemPrompt: string;
  greeting: string;
  tools: Record<string, ToolDef>;
  state?: () => Record<string, unknown>;
  maxSteps?: number;
};

// ---- JSON-RPC 2.0 message shapes --------------------------------------------

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
