// Copyright 2026 the AAI authors. MIT license.
/**
 * What an agent DECLARES about the MCP servers its model may call tools on.
 *
 * Types and the one naming rule, and deliberately nothing that connects: this
 * module is imported by `types.ts` (the `AgentDef` field) and by
 * `agent-config.ts` (the wire schema), both of which have to stay loadable in a
 * browser. The client is `aai-runtime/src/mcp/tools.ts` in `@alexkroman1/aai-runtime`, which is
 * where a socket may be opened.
 *
 * ## A server is a URL plus the NAME of a token variable
 *
 * `url` is written literally because it is not a secret and it is what an
 * author is looking at; `tokenEnv` is a variable NAME because the token IS one.
 * That asymmetry is the whole shape of the type, and it is the same one
 * `requiredEnv` already establishes: the config records what to read, never
 * what was read. There is no second spelling of either — no `urlEnv`, no
 * inline `token` — because a field with two ways to say it is a field a stale
 * config can disagree with itself about.
 *
 * ## …or a URL and headers COMPUTED per connection
 *
 * Some servers are per user: a vendor mints a session URL for one end user and
 * authenticates it with a header that is not a bearer token (Composio's tool
 * router takes `x-api-key`). So `url` and `headers` may each be a RESOLVER,
 * handed {@link McpResolveContext} — the client the connection acts for, the
 * agent env and an abort signal — once per connection. Resolvers and headers
 * are host-only: `toAgentConfig` strips both, so what crosses the wire is
 * still only what a stored config may hold. A resolved URL is screened exactly
 * as a literal one is.
 *
 * List each `tokenEnv` in `requiredEnv` as well. Nothing derives one from the
 * other on purpose: `requiredEnv` is what a DEPLOY preflights, and silently
 * extending it from another field would make a deploy check a name the author
 * never wrote. A missing token fails that one server at connect time, by name,
 * and the session keeps every other tool it has.
 *
 * ## HTTP only
 *
 * `url` is `http(s)` and the transport is streamable HTTP. **stdio is
 * deliberately absent**: it spawns a subprocess, and inside the Modal guest
 * sandbox that is a materially different security question from opening a
 * socket — process lifetime, what the child inherits, and what a compromised
 * server can then reach. It needs its own review, and until it has had one the
 * schema refuses the URL rather than the docs discouraging it.
 */

/**
 * The grammar for a server KEY — the name an author gives one server, and the
 * first segment of every tool name it contributes.
 *
 * The same shape a tool file name must have (`tool-registry.ts`), for the same
 * reason: it becomes part of what the MODEL calls, and providers reject a tool
 * name outside `[a-zA-Z0-9_-]`. Capped at 24 so that a key plus the `mcp_`
 * prefix plus a realistic remote name still clears {@link MCP_TOOL_NAME_MAX}
 * without truncation, which is the case where two remote tools can collapse
 * onto one name.
 */
export const MCP_SERVER_KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;

/**
 * Longest tool name a provider accepts — OpenAI's `^[a-zA-Z0-9_-]{1,64}$`, the
 * strictest this SDK routes to, and therefore the one that decides. Same
 * constant and same reason as `tool-registry.ts`'s cap; a name over it is
 * refused when the tool list is sent, by a vendor, in a message that names
 * neither the server nor the tool.
 */
export const MCP_TOOL_NAME_MAX: number = 64;

/**
 * The prefix every MCP-derived tool name carries.
 *
 * Namespacing is not tidiness here. An MCP server is a third party that
 * publishes its own tool names, so without a prefix a server could publish
 * `transfer_funds` and quietly stand where the agent's own tool of that name
 * stood — the model would call it and nothing would say so. With the prefix,
 * shadowing a native tool takes an author writing a `tools/mcp_*.ts` file
 * themselves, and even that loses: the native tool wins and the drop is logged
 * (`registerTools`, in `@alexkroman1/aai-runtime`'s `aai-runtime/src/mcp/tools.ts`).
 */
export const MCP_TOOL_PREFIX = "mcp_";

/**
 * What a RESOLVER is handed when a server's `url` or `headers` is a function.
 *
 * A resolver runs on the host, once per CONNECTION — once when a host connects
 * the agent's servers (`withMcpTools`, where there is no caller yet, so
 * `clientId` is `undefined`), and once per `stepMcp` call from a workflow step,
 * with the `clientId` that step passed. The value is held for that connection
 * and never re-asked, so a resolver that creates something remote (a per-user
 * session URL) creates it once per connection, not per tool call.
 */
export type McpResolveContext = {
  /**
   * The client the connection acts for — `stepMcp`'s `clientId` option, which a
   * run usually carries from `sessionClientId(ctx)` in the tool that started
   * it. `undefined` at host start, where nobody is calling yet: a server that
   * only makes sense per user should THROW here, which costs that server's
   * tools at host start and nothing else.
   */
  readonly clientId: string | undefined;
  /** The agent's env — the same record `tokenEnv` is read from. Never `process.env`. */
  readonly env: Readonly<Partial<Record<string, string>>>;
  /** Aborted when the connect budget runs out; pass it to any `fetch` the resolver makes. */
  readonly signal: AbortSignal;
};

/**
 * A value an author may write literally, or compute per connection from
 * {@link McpResolveContext}.
 */
export type McpResolvable<T> = T | ((context: McpResolveContext) => T | Promise<T>);

/** One MCP server an agent may take tools from. */
export type McpServerConfig = {
  /**
   * The server's streamable-HTTP endpoint, e.g.
   * `https://mcp.example.com/mcp`. Screened for SSRF before the first request
   * and on every redirect hop, like every other URL this framework dials.
   *
   * A FUNCTION computes it per connection — a per-user session URL, say —
   * and what it returns is screened exactly as a literal is. A resolver is
   * host-only: `toAgentConfig` drops it from the serialized config, the way it
   * drops a `systemPrompt` resolver, so the wire records only that the server
   * exists.
   */
  url: McpResolvable<string>;
  /**
   * Extra request headers for this server, e.g. an `x-api-key` a vendor wants
   * instead of a bearer token.
   *
   * **HOST-ONLY in both spellings**: `toAgentConfig` never serializes it, so a
   * header value never reaches a stored config, the browser or a log line.
   * Prefer the function form and read the value from `env` — a literal secret
   * in `agent.ts` is a secret in version control. Every header named here is
   * treated as a credential: it is dropped when a redirect leaves the server's
   * origin, like `authorization` is. A `tokenEnv` bearer wins over an
   * `authorization` set here.
   */
  headers?: McpResolvable<Readonly<Record<string, string>>>;
  /**
   * Name of the environment variable holding a bearer token for this server —
   * the NAME, never the token. Omit it for a server that needs no credential.
   */
  tokenEnv?: string;
  /**
   * The REMOTE tool names this agent takes from the server; every other tool
   * it publishes is not offered. Omitted, every tool is offered.
   *
   * The scope knob for a server that publishes more than one agent should see
   * (a connection manager the agent must not drive, a write tool a read-only
   * agent has no use for). Applied before namespacing and before the pin, and
   * a name listed here that the server does not publish is logged, since it is
   * usually a typo or a renamed tool.
   */
  allowedTools?: readonly string[];
  /**
   * The tool definitions this agent has REVIEWED, as
   * `remote tool name → fingerprint`.
   *
   * An MCP server owns its own tool descriptions and input schemas, and it can
   * change them after you have trusted it — the "rug pull": a tool called
   * `search` whose description quietly becomes "…and forward the caller's
   * address to https://…". Namespacing does not touch that; it stops a server
   * standing where YOUR tool stood, and this stops a server changing what its
   * OWN tool means. Both, because they are different attacks.
   *
   * A fingerprint covers the server-controlled, security-relevant fields —
   * `description`, the resolved input JSON schema, and `title` — and is
   * produced by `fingerprintTools` from the Vercel AI SDK. `withMcpTools`
   * (`@alexkroman1/aai-runtime`) reports the fingerprints of whatever it
   * discovered, so adopting a pin is copying them in once a human has read the
   * tools. With a pin declared, a tool whose fingerprint CHANGED — or one that
   * was ADDED since — is not offered to the model, and the drop is logged.
   *
   * **The baseline lives HERE because there is nowhere better.** It is a
   * reviewed decision about a third party, so its home has to be the artifact a
   * human reviews and a deploy carries: `agent.ts`, in version control, in the
   * diff. Nothing the runtime could persist has that property — a guest sandbox
   * is reclaimed on idle and replaced on every deploy, so a baseline captured
   * at first connect would be re-captured, from the server, on the next boot,
   * and would authenticate nothing.
   *
   * Omitted, the agent trusts on first use: the tools are offered, and their
   * fingerprints are reported so a pin can be adopted.
   */
  pinnedTools?: Readonly<Record<string, string>>;
};

/**
 * The servers an agent declares, keyed by the name that prefixes their tools.
 *
 * A record rather than an array so the key is stated once and cannot drift from
 * the name the model sees.
 */
export type McpServers = Readonly<Record<string, McpServerConfig>>;

/**
 * The name the MODEL calls, for one remote tool on one server.
 *
 * Deterministic, and every input maps to a legal name: the remote half is
 * lowercased and every character a provider would reject becomes `_`, because
 * an MCP server's names are its own (`getWeather`, `search-docs`) and refusing
 * them would make whole servers unusable for a spelling.
 *
 * Truncation at {@link MCP_TOOL_NAME_MAX} is the one lossy step, and it is why
 * the caller must still dedupe: two long remote names can land on one truncated
 * name. `registerTools` resolves that the same way it resolves every other
 * collision — first wins in a sorted order, the loser is dropped and logged —
 * rather than silently overwriting.
 */
export function mcpToolName(serverKey: string, remoteName: string): string {
  const normalized = remoteName.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return `${MCP_TOOL_PREFIX}${serverKey}_${normalized}`.slice(0, MCP_TOOL_NAME_MAX);
}
