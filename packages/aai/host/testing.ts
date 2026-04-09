// Copyright 2025 the AAI authors. MIT license.
/**
 * Test harness for directory-based agents.
 *
 * Loads tool and hook files from an agent directory and executes them
 * in-process with an in-memory KV store. Designed for agents defined via
 * `agent.json` + `tools/` + `hooks/` rather than `defineAgent()`.
 *
 * @example
 * ```ts
 * import { createTestHarness } from "@alexkroman1/aai/testing";
 *
 * const t = await createTestHarness("./my-agent");
 * const result = await t.executeTool("greet", { name: "Alice" });
 * ```
 *
 * @packageDocumentation
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStorage } from "unstorage";
import type { Kv } from "../isolate/kv.ts";
import type { Message } from "../isolate/types.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";

export { installMockWebSocket, MockWebSocket } from "./_mock-ws.ts";
export { flush, makeStubSession } from "./_test-utils.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single tool call recorded during a turn.
 */
export type RecordedToolCall = {
  /** The name of the tool that was called. */
  name: string;
  /** The arguments passed to the tool. */
  args: Readonly<Record<string, unknown>>;
  /** The result returned by the tool. */
  result: unknown;
};

/**
 * A loaded tool module from the `tools/` directory.
 */
type LoadedTool = {
  default: (args: Record<string, unknown>, ctx: ToolCtx) => unknown | Promise<unknown>;
  description?: string;
  parameters?: unknown;
};

/**
 * A loaded hook module from the `hooks/` directory.
 */
type LoadedHook = {
  default: (ctx: HookCtx) => void | Promise<void>;
};

/**
 * Context passed to tool execute functions in directory-based agents.
 */
type ToolCtx = {
  env: Readonly<Record<string, string>>;
  kv: Kv;
  messages: readonly Message[];
  sessionId: string;
};

/**
 * Context passed to hook functions in directory-based agents.
 */
type HookCtx = {
  env: Readonly<Record<string, string>>;
  kv: Kv;
  sessionId: string;
};

// ─── TurnResult ──────────────────────────────────────────────────────────────

/**
 * Result of a simulated turn. Holds recorded tool calls and provides
 * helpers for extracting results.
 */
export class TurnResult {
  readonly toolCalls: readonly RecordedToolCall[];

  constructor(toolCalls: RecordedToolCall[]) {
    this.toolCalls = toolCalls;
  }

  /**
   * Get the result of the first call to a specific tool.
   * Throws if the tool was not called during this turn.
   */
  toolResult<T = unknown>(toolName: string): T {
    const call = this.toolCalls.find((tc) => tc.name === toolName);
    if (!call) {
      throw new Error(`Tool "${toolName}" was not called during this turn`);
    }
    return call.result as T;
  }
}

// ─── TestHarness ────────────────────────────────────────────────────────────

/**
 * Test harness for directory-based agents.
 *
 * Maintains conversation state, executes tools, and fires hooks in-process
 * with an in-memory KV store.
 */
export class TestHarness {
  private readonly _tools: Map<string, LoadedTool>;
  private readonly _hooks: Map<string, LoadedHook>;
  private readonly _kv: Kv;
  private readonly _sessionId: string;
  private readonly _env: Readonly<Record<string, string>>;
  private _messages: Message[] = [];

  constructor(
    tools: Map<string, LoadedTool>,
    hooks: Map<string, LoadedHook>,
    kv: Kv,
    sessionId: string,
    env: Readonly<Record<string, string>> = {},
  ) {
    this._tools = tools;
    this._hooks = hooks;
    this._kv = kv;
    this._sessionId = sessionId;
    this._env = env;
  }

  /** Conversation messages accumulated across turns. */
  get messages(): readonly Message[] {
    return this._messages;
  }

  /** The KV store used by this harness (useful for assertions). */
  get kv(): Kv {
    return this._kv;
  }

  /**
   * Fire the `onConnect` lifecycle hook.
   */
  async connect(): Promise<void> {
    const hook = this._hooks.get("onConnect");
    if (hook) {
      await hook.default(this._makeHookCtx());
    }
  }

  /**
   * Fire the `onDisconnect` lifecycle hook.
   */
  async disconnect(): Promise<void> {
    const hook = this._hooks.get("onDisconnect");
    if (hook) {
      await hook.default(this._makeHookCtx());
    }
  }

  /**
   * Execute a single tool by name with the given arguments.
   *
   * @param name - The tool to execute.
   * @param args - Arguments to pass to the tool.
   * @returns The tool's result.
   */
  async executeTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this._tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }
    return tool.default(args, this._makeToolCtx());
  }

  /**
   * Simulate a user turn: add the user message, fire onUserTranscript if
   * the hook exists, execute each tool call in sequence, and return a
   * TurnResult.
   *
   * @param text - The user's input text.
   * @param toolCalls - Tool calls to execute in order.
   * @returns A TurnResult with recorded tool calls.
   */
  async turn(
    text: string,
    toolCalls: { tool: string; args: Record<string, unknown> }[] = [],
  ): Promise<TurnResult> {
    // Record user message
    this._messages.push({ role: "user", content: text });

    // Fire onUserTranscript hook if it exists.
    // Supports both signatures: (ctx) and (text, ctx).
    const transcriptHook = this._hooks.get("onUserTranscript");
    if (transcriptHook) {
      if (transcriptHook.default.length >= 2) {
        // Hook expects (text, ctx)
        await (
          transcriptHook.default as unknown as (text: string, ctx: HookCtx) => void | Promise<void>
        )(text, this._makeHookCtx());
      } else {
        // Hook expects (ctx) only
        await transcriptHook.default(this._makeHookCtx());
      }
    }

    // Execute tool calls in sequence
    const recorded: RecordedToolCall[] = [];
    for (const tc of toolCalls) {
      const result = await this.executeTool(tc.tool, tc.args);
      recorded.push({ name: tc.tool, args: tc.args, result });

      // Record tool message in conversation
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      this._messages.push({ role: "tool", content: resultStr });
    }

    return new TurnResult(recorded);
  }

  private _makeToolCtx(): ToolCtx {
    return {
      env: this._env,
      kv: this._kv,
      messages: this._messages,
      sessionId: this._sessionId,
    };
  }

  private _makeHookCtx(): HookCtx {
    return {
      env: this._env,
      kv: this._kv,
      sessionId: this._sessionId,
    };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Options for creating a TestHarness.
 */
export type TestHarnessOptions = {
  /** Environment variables available to tools via `ctx.env`. */
  env?: Record<string, string>;
  /** KV store instance. Defaults to an in-memory store. */
  kv?: Kv;
  /** Session ID. Defaults to a generated test ID. */
  sessionId?: string;
};

/** File extensions to scan for tool/hook modules, in priority order. */
const IMPORTABLE_EXTENSIONS = [".ts", ".mjs", ".js"];

/**
 * Scan a directory for importable files and dynamically import each one.
 *
 * Returns a map of base name (without extension) to the imported module.
 */
async function scanAndImport<T>(dir: string): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  if (!existsSync(dir)) return result;

  const files = readdirSync(dir);
  for (const file of files) {
    const ext = IMPORTABLE_EXTENSIONS.find((e) => file.endsWith(e));
    if (!ext) continue;
    const name = basename(file, ext);
    // Don't re-import if we already have this name (earlier extension wins)
    if (result.has(name)) continue;
    const filePath = join(dir, file);
    const mod = (await import(pathToFileURL(filePath).href)) as T;
    result.set(name, mod);
  }

  return result;
}

/**
 * Map hook filenames to camelCase hook keys.
 *
 * E.g. "on-connect" -> "onConnect", "on-user-transcript" -> "onUserTranscript"
 */
function hookFileNameToKey(fileName: string): string {
  return fileName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Create a test harness for a directory-based agent.
 *
 * Scans the `tools/` and `hooks/` subdirectories of the given agent
 * directory, dynamically imports each module, and wires them up with
 * an in-memory KV store.
 *
 * @param agentDir - Path to the agent directory containing `tools/` and/or `hooks/`.
 * @param options - Optional environment, KV, and session overrides.
 * @returns A TestHarness instance.
 */
export async function createTestHarness(
  agentDir: string,
  options: TestHarnessOptions = {},
): Promise<TestHarness> {
  const {
    env = {},
    kv = createUnstorageKv({ storage: createStorage() }),
    sessionId = `test-${Date.now()}`,
  } = options;

  // Scan and import tools
  const toolsDir = join(agentDir, "tools");
  const tools = await scanAndImport<LoadedTool>(toolsDir);

  // Scan and import hooks, mapping filenames to hook keys
  const hooksDir = join(agentDir, "hooks");
  const rawHooks = await scanAndImport<LoadedHook>(hooksDir);
  const hooks = new Map<string, LoadedHook>();
  for (const [fileName, mod] of rawHooks) {
    hooks.set(hookFileNameToKey(fileName), mod);
  }

  return new TestHarness(tools, hooks, kv, sessionId, env);
}

// ─── Matchers ────────────────────────────────────────────────────────────────

/**
 * Vitest matcher implementation for `toHaveCalledTool`.
 *
 * Exported here so users can import everything from a single entry point:
 * `import { createTestHarness, toHaveCalledTool } from "@alexkroman1/aai/testing"`
 *
 * Also registered as a side-effect when importing
 * `@alexkroman1/aai/testing/matchers`.
 *
 * @example
 * ```ts
 * import { toHaveCalledTool } from "@alexkroman1/aai/testing";
 * expect.extend({ toHaveCalledTool });
 * ```
 *
 * @public
 */
export function toHaveCalledTool(
  received: unknown,
  toolName: string,
  args?: Record<string, unknown>,
) {
  if (!(received instanceof TurnResult)) {
    return {
      pass: false,
      message: () => `expected a TurnResult, got ${typeof received}`,
      actual: received,
      expected: "TurnResult",
    };
  }

  const pass = received.toHaveCalledTool(toolName, args);

  const calledTools = received.toolCalls.map((tc) => tc.toolName);
  const argsHint = args ? ` with args ${JSON.stringify(args)}` : "";

  return {
    pass,
    message: () =>
      pass
        ? `expected turn NOT to have called tool "${toolName}"${argsHint}, but it was called.\nCalled tools: ${JSON.stringify(calledTools)}`
        : `expected turn to have called tool "${toolName}"${argsHint}, but it was not.\nCalled tools: ${JSON.stringify(calledTools)}`,
    actual: calledTools,
    expected: toolName,
  };
}
