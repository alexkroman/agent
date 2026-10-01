// Copyright 2026 the AAI authors. MIT license.
/**
 * An agent's MCP servers, from inside a workflow step — resolved for ONE client.
 *
 * `mcpServers` on an agent is what a HOST connects at start (`withMcpTools`),
 * with nobody calling yet. A per-user server — a vendor that mints one session
 * URL per end user — cannot be connected then, and a run that does a user's
 * work on their apps needs exactly that server, for exactly that user. So a
 * step asks for it by config and client:
 *
 * ```ts
 * import { type McpServers, speaker } from "@alexkroman1/aai";
 * import { stepMcp } from "@alexkroman1/aai/experimental";
 * import { stepDelegate } from "@alexkroman1/aai/step";
 *
 * // The same record agent.ts puts in `mcpServers` — keep it in its own module.
 * const apps: McpServers = {
 *   apps: {
 *     url: ({ clientId }) => `https://mcp.example.com/users/${clientId}`,
 *     headers: ({ env }) => ({ "x-api-key": env.APPS_API_KEY ?? "" }),
 *   },
 * };
 *
 * export async function work(task: string, clientId: string): Promise<string> {
 *   const mcp = await stepMcp(apps, { clientId });
 *   try {
 *     const worker = speaker({
 *       name: "worker",
 *       systemPrompt: "Do the task with the app tools.",
 *       tools: { ...mcp.tools },
 *     });
 *     return (await stepDelegate(worker, { task })).text;
 *   } finally {
 *     await mcp.close();
 *   }
 * }
 * ```
 *
 * What comes back is ordinary `ToolDef`s, named `mcp_<key>_<tool>` exactly as
 * the host-start path names them, so they spread into a `speaker({ tools })`
 * beside the step's own and run on the same executor — deadline, validation,
 * abort signal — as every other tool.
 *
 * ## Resolved once per CALL, with the step's client
 *
 * Every `url`/`headers` resolver in the record runs once per `stepMcp` call,
 * handed the `clientId` given here and the agent env; the resolved values are
 * held for that connection and never re-asked. A resolver that creates a
 * vendor session is therefore one round trip per call — cache the session id
 * yourself, keyed by client, if a run makes many calls.
 *
 * ## An unavailable server REJECTS
 *
 * The host-start path degrades — a voice session must not wait on a third
 * party, so a dead server costs its own tools. A step is the opposite case:
 * it can be retried, and a subagent handed a tool list missing the server it
 * was built for answers "I can't reach your apps" as if that were the truth.
 * So this rejects, naming the server and the reason, after closing whatever
 * did connect — and the step's own retry policy decides what happens next.
 *
 * ## Why a published slot rather than an import
 *
 * The reason `stepDelegate` is one. The MCP client (`@ai-sdk/mcp`, an optional
 * peer of `@alexkroman1/aai-runtime`) and the SSRF-screened fetch are
 * Node-side and must not ride into the agent bundle, so the host publishes a
 * connector (`aai-runtime`'s `step-mcp.ts`, over the same core `withMcpTools`
 * uses) and this module holds the slot and the types. An UNPUBLISHED slot
 * throws — an empty tool list is indistinguishable from a user with nothing
 * connected.
 *
 * ## Call it INSIDE a `ctx.step`, and close it there
 *
 * It opens network connections, so outside a step it would re-run on every
 * replay. Close it in a `finally` in the SAME step: a connection does not
 * survive a step boundary (the next step may run in another process), and
 * nothing else closes it.
 */

import type { McpServers } from "./mcp-config.ts";
import type { ToolMap } from "./tool-def.ts";

/** Options for {@link stepMcp}. */
export type StepMcpOptions = {
  /**
   * The client this connection acts for, handed to every resolver as
   * `McpResolveContext.clientId` — usually carried into the run from
   * `sessionClientId(ctx)` in the tool that started it.
   */
  readonly clientId?: string | undefined;
};

/** What one server contributed to a {@link stepMcp} connection. */
export type StepMcpServer = {
  /** The server's key in the record. */
  readonly key: string;
  /** The tool names it contributed, namespaced (`mcp_<key>_<tool>`). */
  readonly tools: readonly string[];
};

/** An open {@link stepMcp} connection. */
export type StepMcp = {
  /**
   * Every connected server's tools as `ToolDef`s, by the name the model calls
   * them — spread into `speaker({ tools })`.
   */
  readonly tools: ToolMap;
  /** One entry per server in the record, in sorted key order. */
  readonly servers: readonly StepMcpServer[];
  /** Close every connection. Never rejects. Call it in the step's `finally`. */
  close(): Promise<void>;
};

/**
 * What a published connector does: connect a record of servers for one client.
 *
 * @internal
 */
export type StepMcpFn = (servers: McpServers, options: StepMcpOptions) => Promise<StepMcp>;

/** Registry-wide, for the reason `step-delegate.ts`'s slot is. */
const STEP_MCP_SLOT = Symbol.for("@alexkroman1/aai.stepMcp");

type StepMcpSlot = { [STEP_MCP_SLOT]?: StepMcpFn };

/**
 * Publish the connector this process's steps reach MCP servers through.
 * Passing `undefined` UNPUBLISHES.
 *
 * @internal
 */
export function publishStepMcp(connector: StepMcpFn | undefined): void {
  const slot = globalThis as StepMcpSlot;
  if (connector === undefined) delete slot[STEP_MCP_SLOT];
  else slot[STEP_MCP_SLOT] = connector;
}

/**
 * Connect MCP servers for one client from inside a step, and get their tools
 * as `ToolDef`s.
 *
 * Rejects when nothing has published a connector, or when any server in the
 * record is unavailable (unreachable, refused by the SSRF screen, a resolver
 * that threw, a missing `tokenEnv`) — see the module doc for why a step
 * rejects where a host degrades.
 *
 * @public
 */
export function stepMcp(servers: McpServers, options: StepMcpOptions = {}): Promise<StepMcp> {
  const connector = (globalThis as StepMcpSlot)[STEP_MCP_SLOT];
  if (!connector) {
    return Promise.reject(
      new Error(
        `stepMcp(${Object.keys(servers).join(", ")}): no MCP connector is published in this ` +
          "process. A host publishes one when it serves workflows (`aai dev`, `aai start`, a " +
          "deployed guest, `createAgentServer`); in a spec, publish a fake with " +
          "`stubStepMcp` from `@alexkroman1/aai/experimental`.",
      ),
    );
  }
  return connector(servers, options);
}

/**
 * Publish a fake connector for a spec: every {@link stepMcp} call answers
 * `tools` (default none) and records what it was asked. Call `restore()` in
 * the spec's teardown.
 *
 * @public
 */
export function stubStepMcp(tools: ToolMap = {}): {
  /** Each call's server keys and options, in order. */
  readonly calls: readonly { readonly keys: readonly string[]; readonly options: StepMcpOptions }[];
  /** Unpublish the fake. */
  restore(): void;
} {
  const calls: { keys: string[]; options: StepMcpOptions }[] = [];
  const slot = globalThis as StepMcpSlot;
  const previous = slot[STEP_MCP_SLOT];
  publishStepMcp(async (servers, options) => {
    const keys = Object.keys(servers).sort();
    calls.push({ keys, options });
    return {
      tools,
      servers: keys.map((key) => ({ key, tools: Object.keys(tools) })),
      close: async () => undefined,
    };
  });
  return { calls, restore: () => publishStepMcp(previous) };
}
