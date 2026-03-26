// Copyright 2025 the AAI authors. MIT license.
/**
 * Testing utilities for AAI agents.
 *
 * Provides a test harness for unit-testing agents without audio, network,
 * or an LLM. Use {@link createTestHarness} to create a harness from a
 * `defineAgent()` result, then drive tool calls and multi-turn conversations.
 *
 * @example
 * ```ts
 * import { describe, expect, test } from "vitest";
 * import { createTestHarness } from "@alexkroman1/aai/testing";
 * import agent from "./agent.ts";
 *
 * describe("my agent", () => {
 *   test("greet tool returns greeting", async () => {
 *     const t = createTestHarness(agent);
 *     const result = await t.executeTool("greet", { name: "Alice" });
 *     expect(result).toBe("Hello, Alice!");
 *   });
 *
 *   test("multi-turn conversation", async () => {
 *     const t = createTestHarness(agent);
 *     const turn1 = await t.turn("Add a pizza", [
 *       { tool: "add_pizza", args: { size: "large", crust: "regular", toppings: ["pepperoni"], quantity: 1 } },
 *     ]);
 *     expect(turn1).toHaveCalledTool("add_pizza");
 *
 *     const turn2 = await t.turn("View my order", [
 *       { tool: "view_order", args: {} },
 *     ]);
 *     expect(turn2).toHaveCalledTool("view_order");
 *   });
 * });
 * ```
 *
 * @packageDocumentation
 */

import { createDirectExecutor, type DirectExecutor } from "./direct-executor.ts";
import type { Kv } from "./kv.ts";
import { createSqliteKv } from "./sqlite-kv.ts";
import { createSqliteVectorStore } from "./sqlite-vector.ts";
import type { AgentDef, Message, StepInfo } from "./types.ts";
import type { VectorStore } from "./vector.ts";

export { installMockWebSocket, MockWebSocket } from "./_mock-ws.ts";

// ─── TurnResult ──────────────────────────────────────────────────────────────

/**
 * A single tool call recorded during a turn.
 *
 * @public
 */
export type RecordedToolCall = {
  /** The name of the tool that was called. */
  toolName: string;
  /** The arguments passed to the tool. */
  args: Readonly<Record<string, unknown>>;
  /** The string result returned by the tool. */
  result: string;
};

/**
 * Result of a simulated turn via {@link TestHarness.turn}.
 *
 * Contains all tool calls that were executed and provides assertion helpers
 * for verifying agent behavior in tests.
 *
 * @example
 * ```ts
 * const result = await t.turn("search for flights", [
 *   { tool: "search_flights", args: { destination: "NYC" } },
 * ]);
 *
 * // Check if a tool was called
 * expect(result).toHaveCalledTool("search_flights");
 *
 * // Check tool was called with specific args
 * expect(result).toHaveCalledTool("search_flights", { destination: "NYC" });
 *
 * // Access raw tool call data
 * expect(result.toolCalls[0].result).toContain("JFK");
 * ```
 *
 * @public
 */
export class TurnResult {
  /** The user text that initiated this turn. */
  readonly text: string;
  /** All tool calls executed during this turn, in order. */
  readonly toolCalls: readonly RecordedToolCall[];
  /** Convenience accessor: just the result strings from each tool call. */
  readonly toolResults: readonly string[];

  /** @internal */
  constructor(text: string, toolCalls: RecordedToolCall[]) {
    this.text = text;
    this.toolCalls = toolCalls;
    this.toolResults = toolCalls.map((tc) => tc.result);
  }

  /**
   * Check whether a tool was called during this turn.
   *
   * When `args` is provided, checks that at least one call to the named tool
   * contains all specified key-value pairs (partial match).
   *
   * @param toolName - The tool name to look for.
   * @param args - Optional partial args to match against.
   * @returns `true` if a matching tool call was found.
   *
   * @example
   * ```ts
   * result.toHaveCalledTool("add_pizza"); // any call
   * result.toHaveCalledTool("add_pizza", { size: "large" }); // partial match
   * ```
   */
  toHaveCalledTool(toolName: string, args?: Record<string, unknown>): boolean {
    return this.toolCalls.some((tc) => {
      if (tc.toolName !== toolName) return false;
      if (!args) return true;
      return Object.entries(args).every(
        ([key, value]) => JSON.stringify(tc.args[key]) === JSON.stringify(value),
      );
    });
  }

  /**
   * Get all calls to a specific tool during this turn.
   *
   * @param toolName - The tool name to filter by.
   * @returns Array of matching tool calls (may be empty).
   */
  getToolCalls(toolName: string): readonly RecordedToolCall[] {
    return this.toolCalls.filter((tc) => tc.toolName === toolName);
  }

  /**
   * Get the parsed JSON result of the first call to a specific tool.
   *
   * Throws if the tool was not called during this turn.
   *
   * @typeParam T - The expected shape of the parsed result.
   * @param toolName - The tool name to look up.
   * @returns The parsed result, cast to `T`.
   *
   * @example
   * ```ts
   * const order = turn.toolResult<{ pizzas: Pizza[]; total: string }>("view_order");
   * expect(order.pizzas).toHaveLength(2);
   * ```
   */
  toolResult<T = unknown>(toolName: string): T {
    const call = this.toolCalls.find((tc) => tc.toolName === toolName);
    if (!call) {
      throw new Error(`Tool "${toolName}" was not called during this turn`);
    }
    return JSON.parse(call.result) as T;
  }
}

// ─── TestHarness ─────────────────────────────────────────────────────────────

/**
 * Options for creating a {@link TestHarness}.
 *
 * @public
 */
export type TestHarnessOptions = {
  /** Environment variables available to tools via `ctx.env`. */
  env?: Record<string, string>;
  /** KV store instance. Defaults to an in-memory SQLite store. */
  kv?: Kv;
  /** Vector store instance. Defaults to an in-memory SQLite store. */
  vector?: VectorStore;
};

/**
 * A tool call to execute during a simulated turn.
 *
 * @public
 */
export type TurnToolCall = {
  /** The tool name to invoke. */
  tool: string;
  /** Arguments to pass to the tool. */
  args: Record<string, unknown>;
};

/**
 * Test harness for unit-testing AAI agents without audio, network, or LLM.
 *
 * Created via {@link createTestHarness}. Maintains conversation state across
 * turns, executes tools against the real agent code, and records all tool
 * calls for assertions.
 *
 * @example
 * ```ts
 * import { createTestHarness } from "@alexkroman1/aai/testing";
 * import agent from "./agent.ts";
 *
 * const t = createTestHarness(agent);
 *
 * // Execute a single tool
 * const result = await t.executeTool("greet", { name: "Alice" });
 *
 * // Simulate a full turn with tool calls
 * const turn = await t.turn("hello", [
 *   { tool: "greet", args: { name: "Alice" } },
 * ]);
 * expect(turn).toHaveCalledTool("greet");
 * ```
 *
 * @public
 */
export class TestHarness {
  /** @internal */
  readonly _executor: DirectExecutor;
  /** @internal */
  readonly _sessionId: string;

  private _messages: Message[] = [];
  private _onStepCalls: StepInfo[] = [];
  private _onTurnCalls: string[] = [];
  private _connected = false;

  /** @internal */
  constructor(executor: DirectExecutor, sessionId: string) {
    this._executor = executor;
    this._sessionId = sessionId;
  }

  /** Conversation messages accumulated across turns. */
  get messages(): readonly Message[] {
    return this._messages;
  }

  /** All `onStep` hook invocations recorded so far. */
  get steps(): readonly StepInfo[] {
    return this._onStepCalls;
  }

  /** All `onTurn` hook invocations (the text argument) recorded so far. */
  get turns(): readonly string[] {
    return this._onTurnCalls;
  }

  /**
   * Fire the `onConnect` lifecycle hook.
   *
   * Called automatically on the first {@link turn} call if not called manually.
   */
  async connect(): Promise<void> {
    if (this._connected) return;
    this._connected = true;
    await this._executor.hookInvoker.onConnect(this._sessionId);
  }

  /**
   * Fire the `onDisconnect` lifecycle hook and clean up session state.
   */
  async disconnect(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    await this._executor.hookInvoker.onDisconnect(this._sessionId);
  }

  /**
   * Execute a single tool by name with the given arguments.
   *
   * The tool runs with full agent context (env, state, kv, vector, messages).
   * The call is **not** recorded in conversation history — use {@link turn}
   * for that.
   *
   * @param toolName - The tool to execute.
   * @param args - Arguments to pass to the tool.
   * @returns The tool's string result.
   *
   * @example
   * ```ts
   * const result = await t.executeTool("get_weather", { city: "London" });
   * const data = JSON.parse(result);
   * expect(data.temp).toBeDefined();
   * ```
   */
  async executeTool(toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    return this._executor.executeTool(toolName, args, this._sessionId, this._messages);
  }

  /**
   * Simulate a user turn: add the user message, execute the given tool calls
   * in sequence, and record everything.
   *
   * This is the primary method for testing agent behavior. It:
   * 1. Fires `onConnect` if this is the first turn
   * 2. Adds the user message to conversation history
   * 3. Fires the `onTurn` hook
   * 4. Executes each tool call in order, firing `onStep` for each
   * 5. Returns a {@link TurnResult} with assertion helpers
   *
   * @param text - The user's spoken/typed input.
   * @param toolCalls - Tool calls to execute (simulating what the LLM would invoke).
   * @returns A {@link TurnResult} with recorded tool calls and assertion methods.
   *
   * @example
   * ```ts
   * const turn = await t.turn("Add pepperoni pizza", [
   *   { tool: "add_pizza", args: { size: "large", crust: "regular", toppings: ["pepperoni"], quantity: 1 } },
   * ]);
   * expect(turn).toHaveCalledTool("add_pizza", { size: "large" });
   * expect(turn.toolCalls[0].result).toContain("$14.99");
   * ```
   */
  async turn(text: string, toolCalls: TurnToolCall[] = []): Promise<TurnResult> {
    await this.connect();

    // Record user message
    this._messages.push({ role: "user", content: text });

    // Fire onTurn hook
    this._onTurnCalls.push(text);
    await this._executor.hookInvoker.onTurn(this._sessionId, text);

    // Execute tool calls
    const recorded: RecordedToolCall[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i] as TurnToolCall;
      const result = await this._executor.executeTool(
        tc.tool,
        tc.args,
        this._sessionId,
        this._messages,
      );

      recorded.push({ toolName: tc.tool, args: tc.args, result });

      // Record tool message in conversation
      this._messages.push({ role: "tool", content: result });

      // Fire onStep hook
      const step: StepInfo = {
        stepNumber: i + 1,
        toolCalls: [{ toolName: tc.tool, args: tc.args }],
        text: "",
      };
      this._onStepCalls.push(step);
      await this._executor.hookInvoker.onStep(this._sessionId, step);
    }

    return new TurnResult(text, recorded);
  }

  /**
   * Add a user message to conversation history without executing tools.
   *
   * Useful for setting up conversation context before a turn.
   */
  addUserMessage(text: string): void {
    this._messages.push({ role: "user", content: text });
  }

  /**
   * Add an assistant message to conversation history.
   *
   * Useful for simulating prior assistant responses in multi-turn tests.
   */
  addAssistantMessage(text: string): void {
    this._messages.push({ role: "assistant", content: text });
  }

  /**
   * Reset conversation state: clears messages, step/turn history.
   *
   * Does **not** reset KV or vector store — create a new harness for that.
   */
  reset(): void {
    this._messages = [];
    this._onStepCalls = [];
    this._onTurnCalls = [];
  }
}

/**
 * Create a test harness for unit-testing an agent.
 *
 * The harness wraps the agent's tool definitions and lifecycle hooks,
 * providing a simple API for executing tools and simulating multi-turn
 * conversations — all without audio, network, or an LLM.
 *
 * @param agent - The agent definition returned by `defineAgent()`.
 * @param options - Optional environment, KV, and vector store overrides.
 * @returns A {@link TestHarness} instance.
 *
 * @example
 * ```ts
 * import { createTestHarness } from "@alexkroman1/aai/testing";
 * import agent from "./agent.ts";
 *
 * const t = createTestHarness(agent);
 * const result = await t.executeTool("my_tool", { key: "value" });
 * ```
 *
 * @example With environment variables
 * ```ts
 * const t = createTestHarness(agent, {
 *   env: { API_KEY: "test-key" },
 * });
 * ```
 *
 * @public
 */
export function createTestHarness(
  // biome-ignore lint/suspicious/noExplicitAny: accepts any state type
  agent: AgentDef<any>,
  options: TestHarnessOptions = {},
): TestHarness {
  const {
    env = {},
    kv = createSqliteKv({ path: ":memory:" }),
    vector = createSqliteVectorStore({ path: ":memory:" }),
  } = options;

  const executor = createDirectExecutor({ agent, env, kv, vector });
  const sessionId = `test-${Date.now()}`;

  return new TestHarness(executor, sessionId);
}
