// Copyright 2026 the AAI authors. MIT license.
/**
 * The types, constants and REST client behind `composio()` — split from
 * `composio.ts` so each stays under the source-length cap. The module doc of
 * `composio.ts` owns the rules.
 *
 * @module composio-api
 */

import { isRecord } from "./is-record.ts";
import { HttpError, type JsonClient, jsonClient } from "./json-client.ts";
import type { McpServerConfig } from "./mcp-config.ts";
import { requireEnv } from "./require-env.ts";
import type { EnvContext } from "./step-env.ts";

/** Composio's REST v3.1 base URL — the default {@link ComposioOptions.baseUrl}. @public */
export const COMPOSIO_BASE_URL: string = "https://backend.composio.dev/api/v3.1";

/** The env var the project key is read from by default. @public */
export const COMPOSIO_API_KEY_ENV: string = "COMPOSIO_API_KEY";

/**
 * Composio's meta tools {@link ComposioClient.mcpServer} offers by default:
 * search, schemas, execute, and the Python workbench. Not
 * `COMPOSIO_MANAGE_CONNECTIONS` (connecting is the page's) nor the bash tool
 * (the workbench covers it).
 *
 * @public
 */
export const COMPOSIO_MCP_TOOLS: readonly string[] = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH",
];

/** How one session kind is made. @public */
export interface ComposioSessionConfig {
  /** Composio's Python workbench (`COMPOSIO_REMOTE_WORKBENCH`) in this session. Default `false`. */
  workbench?: boolean;
  /**
   * Composio's in-chat connection manager (`COMPOSIO_MANAGE_CONNECTIONS`).
   * Default `false`: connecting belongs to a page, through
   * {@link ComposioClient.connectLink}.
   */
  manageConnections?: boolean;
}

/**
 * Where session ids outlive the process — a database table, typically. The
 * default is in memory. `ctx` carries the env a store's own client reads (and
 * no signal: a store write is part of a session create no caller may cancel).
 * A `get` answering a stale id is fine: its first 404 replaces it.
 *
 * @public
 */
export interface ComposioSessionStore {
  get(
    user: string,
    kind: string,
    ctx: EnvContext,
  ): Promise<string | undefined> | string | undefined;
  set(user: string, kind: string, id: string, ctx: EnvContext): Promise<void> | void;
  delete(user: string, kind: string, ctx: EnvContext): Promise<void> | void;
}

/** What `composio()` takes. @public */
export interface ComposioOptions<K extends string> {
  /** The env var holding the project key. Default {@link COMPOSIO_API_KEY_ENV}. */
  apiKeyEnv?: string;
  /** The REST base URL, `https://` only. Default {@link COMPOSIO_BASE_URL}. */
  baseUrl?: string;
  /**
   * The session kinds, by the name methods take as `kind`. The FIRST is the
   * default kind. Default `{ default: {} }`.
   */
  sessions?: Readonly<Record<K, ComposioSessionConfig>>;
  /** Where session ids persist. Default: this process's memory only. */
  sessionStore?: ComposioSessionStore;
}

/**
 * One action's outcome. Composio refusing the REQUEST (bad inputs, an app not
 * connected — a 4xx other than 401/403/429) is `ok: false`, like the action's
 * own failure; a bad key, a forbidden project, a rate limit or a 5xx THROWS.
 *
 * @public
 */
export type ComposioExecuteResult =
  | { ok: true; data: unknown; logId: string }
  | { ok: false; error: string; logId?: string };

/** An app as {@link ComposioClient.listApps} answers it. @public */
export interface ComposioApp {
  /** The toolkit slug (`"gmail"`) the other methods take as `app`. */
  slug: string;
  /** Its display name. */
  name: string;
  /** Its logo's URL (`""` when Composio has none). */
  logo: string;
  /** Whitespace collapsed, at most 240 characters. */
  description: string;
  /** The user has an ACTIVE connected account for it. */
  connected: boolean;
}

/** What {@link ComposioClient.listApps} lists. @public */
export interface ComposioListAppsOptions {
  /** Search the catalog by this text. Ignored with `connectedOnly`. */
  search?: string;
  /** Only the apps the user has connected. */
  connectedOnly?: boolean;
  /** Most catalog entries asked for. Default 20. */
  limit?: number;
}

/** A trigger type an app offers, as {@link ComposioClient.findTriggers} answers it. @public */
export interface ComposioTriggerType {
  /** The trigger slug {@link ComposioClient.upsertTrigger} takes. */
  slug: string;
  /** Its display name. */
  name: string;
  /** Whitespace collapsed, at most 200 characters. */
  description: string;
  /** Composio POLLS for it (minutes) rather than being pushed it (seconds). */
  polled: boolean;
  /** Its `trigger_config` fields. */
  config: { name: string; type: string; required: boolean; description?: string }[];
}

/** What {@link ComposioClient.mcpServer} takes. @public */
export interface ComposioMcpServerOptions<K extends string> {
  /** The session kind the server is. */
  kind: K;
  /** The meta tools offered. Default {@link COMPOSIO_MCP_TOOLS}. */
  allowedTools?: readonly string[];
}

/** What `composio()` returns. @public */
export interface ComposioClient<K extends string> {
  /**
   * Run one tool (`"GMAIL_SEND_EMAIL"`) on the user's connected account,
   * through their `kind` session (default: the first declared kind).
   */
  execute(
    ctx: EnvContext,
    user: string,
    toolSlug: string,
    args: Readonly<Record<string, unknown>>,
    options?: { kind?: K },
  ): Promise<ComposioExecuteResult>;
  /**
   * Apps for a page: the catalog (or its `search`), or only the connected
   * ones. Apps that need no auth are left out; `connected` is checked against
   * the user's OWN active accounts.
   */
  listApps(
    ctx: EnvContext,
    user: string,
    options?: ComposioListAppsOptions,
  ): Promise<ComposioApp[]>;
  /** Composio's hosted page for connecting `app`, which returns to `callbackUrl`. */
  connectLink(
    ctx: EnvContext,
    user: string,
    app: string,
    callbackUrl: string,
    options?: { kind?: K },
  ): Promise<string>;
  /**
   * Remove the user's connection to `app`. The account is looked up among THIS
   * user's own, never taken from a caller, so one user cannot remove another's.
   * `false` when there was none.
   */
  disconnect(ctx: EnvContext, user: string, app: string): Promise<boolean>;
  /**
   * The trigger types `app` offers, without those needing a webhook registered
   * with the provider by hand (`requires_webhook_endpoint_setup`). Default
   * `limit` 20.
   */
  findTriggers(
    ctx: EnvContext,
    app: string,
    options?: { limit?: number },
  ): Promise<ComposioTriggerType[]>;
  /**
   * Create (or find: the same slug and config is the same instance) a trigger
   * on the user's connected account. Answers its trigger id.
   */
  upsertTrigger(
    ctx: EnvContext,
    user: string,
    slug: string,
    config: Readonly<Record<string, unknown>>,
  ): Promise<string>;
  /** Delete a trigger instance. `false` when Composio had none (a 404). */
  deleteTrigger(ctx: EnvContext, triggerId: string): Promise<boolean>;
  /**
   * The user's `kind` session as an MCP server, for `mcpServers` or `stepMcp`
   * (whose `clientId` is the Composio user). The URL is the session's hosted
   * endpoint, read per connection; the header is the project key.
   */
  mcpServer(options: ComposioMcpServerOptions<K>): McpServerConfig;
  /** The raw REST client (key, base URL and error formatting applied), for what the rest does not wrap. */
  api: JsonClient;
}

/**
 * Composio's error sentence: `message`, then `: ` and each of `errors[]`,
 * then ` (request <id>)`. `undefined` for a body not of that shape.
 *
 * @public
 */
export function composioErrorMessage(body: unknown): string | undefined {
  const err = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  if (typeof err?.message !== "string") return undefined;
  const errors = Array.isArray(err.errors)
    ? err.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
    : [];
  const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
  const request = typeof err.request_id === "string" ? ` (request ${err.request_id})` : "";
  return `${err.message}${detail}${request}`;
}

/**
 * `err` with every occurrence of `key` replaced in its message and body — or
 * `err` itself when neither carries it. Rebuilt WITHOUT a `cause`: the cause
 * would carry the unredacted original.
 */
function redacted(err: unknown, key: string): unknown {
  if (!(err instanceof HttpError) || key === "") return err;
  const text = err.body === undefined ? undefined : JSON.stringify(err.body);
  if (!(err.message.includes(key) || text?.includes(key))) return err;
  const scrub = (t: string) => t.split(key).join("[redacted]");
  return new HttpError(
    err.status,
    scrub(err.message),
    text === undefined ? undefined : JSON.parse(scrub(text)),
  );
}

/**
 * The REST client every Composio call goes through: the key read per call, the
 * error formatter, and the key scrubbed from any refusal.
 *
 * @internal
 */
export function composioApi(
  options: { apiKeyEnv?: string | undefined; baseUrl?: string | undefined } = {},
): JsonClient {
  const keyEnv = options.apiKeyEnv ?? COMPOSIO_API_KEY_ENV;
  const baseUrl = options.baseUrl ?? COMPOSIO_BASE_URL;
  if (!/^https:\/\//.test(baseUrl)) {
    throw new Error(`composio: baseUrl must be an https:// URL, got ${JSON.stringify(baseUrl)}`);
  }
  const raw = jsonClient({
    label: "Composio",
    baseUrl,
    headers: (env) => ({ "x-api-key": requireEnv({ env }, keyEnv) }),
    errorMessage: composioErrorMessage,
  });
  return async <T>(...args: Parameters<JsonClient>): Promise<T> => {
    try {
      return await raw<T>(...args);
    } catch (err) {
      throw redacted(err, args[0].env[keyEnv] ?? "");
    }
  };
}
