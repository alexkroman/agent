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

// Minimal Kv-shaped adapter passed to tool contexts
export type KvAdapter = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void>;
  delete(key: string | string[]): Promise<void>;
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

export type ToolContext = {
  env: Readonly<Record<string, string>>;
  state: Record<string, unknown>;
  kv: KvAdapter;
  vector: VectorAdapter;
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
