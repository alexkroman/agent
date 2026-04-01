// Provides editor IntelliSense for AAI agent projects.
// Not imported at runtime. Dropped by `aai init`.

type BuiltinTool = "web_search" | "visit_webpage" | "fetch_json" | "run_code";
type ToolChoice = "auto" | "required" | "none" | { type: "tool"; toolName: string };
type Message = { role: "user" | "assistant" | "tool"; content: string };

type Kv = {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: { expireIn?: number }): Promise<void>;
  delete(...keys: string[]): Promise<void>;
  keys(options?: { limit?: number; reverse?: boolean }): Promise<string[]>;
  list<T = unknown>(options?: { limit?: number; reverse?: boolean }): Promise<{ key: string; value: T }[]>;
  clear(): Promise<void>;
};

type ToolContext<S = Record<string, unknown>> = {
  env: Readonly<Record<string, string>>;
  state: S;
  kv: Kv;
  messages: readonly Message[];
  fetch: typeof globalThis.fetch;
  sessionId: string;
};

type JSONSchemaObject = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

type ToolDef<S = Record<string, unknown>> = {
  description: string;
  parameters?: JSONSchemaObject;
  execute(args: Record<string, unknown>, ctx: ToolContext<S>): Promise<unknown> | unknown;
};

type AgentTools<S = Record<string, unknown>> = {
  tools?: Record<string, ToolDef<S>>;
  state?: () => S;
};
