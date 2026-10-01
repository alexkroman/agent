// Copyright 2026 the AAI authors. MIT license.
/**
 * `composio()` — the Composio Platform integration an agent otherwise writes
 * for itself: per-user tool-router sessions, one action run by CODE, the apps a
 * user can connect, Connect Links, triggers, and the session's hosted MCP
 * endpoint as an `mcpServers` / `stepMcp` entry. REST v3.1
 * (https://docs.composio.dev/reference/api-reference), over `jsonClient`.
 *
 * On `@alexkroman1/aai/experimental`: one app uses it and the API is not
 * settled.
 *
 * ## Identity
 *
 * Every method that acts for someone takes the Composio `user` id — the
 * AUTHOR's id for them (a client id, an account id), never a model's. A
 * connected account is the user's, so any session of that user sees it.
 *
 * ## Sessions
 *
 * A session is made once per `(user, kind)` and reused: held as a promise in
 * this process (concurrent first calls share one create) and in the
 * `ComposioSessionStore` across processes. A request that answers a 404
 * naming the session (Composio expired or lost it) forgets it and makes a new
 * one, ONCE — the connections are the user's, so the new session sees them all.
 * A session is made WITHOUT the caller's signal: a barge-in must not kill the
 * create every other call is waiting on.
 *
 * `kinds` are the author's: `sessions: { voice: { workbench: false },
 * background: { workbench: true } }`. Composio's in-chat connection manager is
 * OFF unless a kind asks for it — an agent that connects accounts on a page
 * does not want a model reading OAuth links aloud.
 *
 * ## Errors
 *
 * A refusal throws `HttpError` with Composio's own detail —
 * `{ error: { message, errors[], request_id } }` read by
 * `composioErrorMessage` — so the message names WHICH field failed and
 * the request id its dashboard looks a failure up by. The API key never
 * appears in a message or body: it is scrubbed if Composio echoes it.
 *
 * ## Not SSRF-screened, by design
 *
 * The base URL is the author's (a literal `https://` string, default
 * `COMPOSIO_BASE_URL`), never a model's; a model-chosen URL belongs to
 * `fetchJson`. The MCP url a session answers IS screened, by the MCP client,
 * like every URL it dials.
 *
 * @module composio
 */

import {
  COMPOSIO_API_KEY_ENV,
  COMPOSIO_MCP_TOOLS,
  type ComposioClient,
  type ComposioOptions,
  type ComposioSessionConfig,
  type ComposioSessionStore,
  composioApi,
} from "./composio-api.ts";
import { HttpError } from "./json-client.ts";
import { createOwnedMap } from "./owned-map.ts";
import { requireEnv } from "./require-env.ts";
import type { EnvContext } from "./step-env.ts";

/** Longest app description {@link ComposioClient.listApps} answers, in characters. */
const MAX_APP_DESCRIPTION = 240;
/** Longest trigger / config-field description {@link ComposioClient.findTriggers} answers. */
const MAX_TRIGGER_DESCRIPTION = 200;
const MAX_FIELD_DESCRIPTION = 120;

type Toolkit = {
  name: string;
  slug: string;
  no_auth?: boolean | null;
  meta?: { logo?: string; description?: string };
};

type Account = { id: string; user_id: string; status: string; toolkit: { slug: string } };

type TriggerTypes = {
  items: {
    slug: string;
    name: string;
    description?: string;
    type?: string;
    config?: {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    requires_webhook_endpoint_setup?: boolean;
  }[];
};

/** A 4xx Composio answers for the REQUEST (inputs, connection), not for the key or the rate. */
function isRequestRefusal(err: unknown): err is HttpError {
  return (
    err instanceof HttpError &&
    err.status >= 400 &&
    err.status < 500 &&
    ![401, 403, 429].includes(err.status)
  );
}

function trimDescription(text: string | undefined, max: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const enc = encodeURIComponent;

/**
 * A Composio Platform client for an agent's tools, routes and steps.
 *
 * @example
 * ```ts
 * import { composio, stepMcp } from "@alexkroman1/aai/experimental";
 * import type { EnvContext } from "@alexkroman1/aai/step";
 *
 * declare const ctx: EnvContext; // a tool's `ctx`, or `stepEnvContext()` in a step
 * declare const userId: string;
 * declare const clientId: string;
 *
 * export const apps = composio({
 *   sessions: { voice: {}, background: { workbench: true } },
 * });
 *
 * // In a tool: send mail from the user's own Gmail.
 * const sent = await apps.execute(ctx, userId, "GMAIL_SEND_EMAIL", {
 *   recipient_email: "sam@example.com",
 *   subject: "Hi",
 *   body: "…",
 * });
 *
 * // In a workflow step: the background session's meta tools.
 * const mcp = await stepMcp({ composio: apps.mcpServer({ kind: "background" }) }, { clientId });
 * ```
 *
 * @public
 */
export function composio<K extends string = "default">(
  options: ComposioOptions<K> = {},
): ComposioClient<K> {
  const api = composioApi(options);
  const kinds = (options.sessions ?? { default: {} }) as Readonly<
    Record<string, ComposioSessionConfig>
  >;
  const defaultKind = Object.keys(kinds)[0];
  if (defaultKind === undefined) throw new Error("composio: `sessions` names no session kind");
  const keyEnv = options.apiKeyEnv ?? COMPOSIO_API_KEY_ENV;
  const memory = new Map<string, string>();
  const store: ComposioSessionStore = options.sessionStore ?? {
    get: (user, kind) => memory.get(`${kind}:${user}`),
    set: (user, kind, id) => void memory.set(`${kind}:${user}`, id),
    delete: (user, kind) => void memory.delete(`${kind}:${user}`),
  };
  /** Session ids by `kind:user`, in front of the store. */
  const sessions = createOwnedMap<string, Promise<string>>();

  const configOf = (kind: string): ComposioSessionConfig => {
    const config = kinds[kind];
    if (!config) {
      throw new Error(
        `composio: no session kind ${JSON.stringify(kind)} (declared: ${Object.keys(kinds).join(", ")})`,
      );
    }
    return config;
  };

  async function createSession(env: EnvContext, user: string, kind: string): Promise<string> {
    const stored = await store.get(user, kind, env);
    if (stored) return stored;
    const config = configOf(kind);
    const created = await api<{ session_id: string }>(env, "POST", "/tool_router/session", {
      user_id: user,
      manage_connections: { enable: config.manageConnections ?? false },
      workbench: { enable: config.workbench ?? false },
    });
    await store.set(user, kind, created.session_id, env);
    return created.session_id;
  }

  function sessionId(ctx: EnvContext, user: string, kind: string): Promise<string> {
    const key = `${kind}:${user}`;
    const held = sessions.get(key);
    if (held !== undefined) return held;
    configOf(kind);
    // Without the caller's signal — see the module doc.
    const id = createSession({ env: ctx.env }, user, kind);
    const release = sessions.claim(key, id);
    // A failure is not remembered: the next call tries again.
    id.catch(() => release());
    return id;
  }

  /** A call under `/tool_router/session/{id}`, remade once on a 404 naming the session. */
  async function inSession<T>(
    ctx: EnvContext,
    user: string,
    kind: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const key = `${kind}:${user}`;
    const held = sessionId(ctx, user, kind);
    const id = await held;
    try {
      return await api<T>(ctx, method, `/tool_router/session/${enc(id)}${path}`, body);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404 && /session/i.test(err.message))) {
        throw err;
      }
      // Only the caller still holding the lost id forgets it: a concurrent
      // caller that already remade the session must not have it deleted.
      if (sessions.owns(key, held)) {
        sessions.delete(key);
        await store.delete(user, kind, { env: ctx.env });
      }
      const fresh = await sessionId(ctx, user, kind);
      return await api<T>(ctx, method, `/tool_router/session/${enc(fresh)}${path}`, body);
    }
  }

  /** The user's ACTIVE connected accounts, by app slug. */
  async function accounts(ctx: EnvContext, user: string): Promise<Map<string, string>> {
    const q = new URLSearchParams({ user_ids: user, statuses: "ACTIVE", limit: "100" });
    const { items = [] } = await api<{ items?: Account[] }>(ctx, "GET", `/connected_accounts?${q}`);
    // Checked again here: a filter Composio ignored must not show another user's account.
    const mine = items.filter((a) => a.user_id === user && a.status === "ACTIVE");
    return new Map(mine.map((a) => [a.toolkit.slug, a.id]));
  }

  return {
    api,

    async execute(ctx, user, toolSlug, args, opts = {}) {
      let out: { data?: unknown; error?: string | null; log_id: string };
      try {
        out = await inSession(ctx, user, opts.kind ?? defaultKind, "POST", "/execute", {
          tool_slug: toolSlug,
          arguments: args,
        });
      } catch (err) {
        if (!isRequestRefusal(err)) throw err;
        return { ok: false, error: err.message };
      }
      if (out.error) return { ok: false, error: out.error, logId: out.log_id };
      return { ok: true, data: out.data, logId: out.log_id };
    },

    async listApps(ctx, user, opts = {}) {
      const connected = await accounts(ctx, user);
      let toolkits: Toolkit[];
      if (opts.connectedOnly) {
        toolkits = await Promise.all(
          [...connected.keys()].map((slug) => api<Toolkit>(ctx, "GET", `/toolkits/${enc(slug)}`)),
        );
      } else {
        const q = new URLSearchParams({ limit: String(opts.limit ?? 20) });
        if (opts.search) q.set("search", opts.search);
        toolkits = (await api<{ items?: Toolkit[] }>(ctx, "GET", `/toolkits?${q}`)).items ?? [];
      }
      return toolkits
        .filter((t) => !t.no_auth)
        .map((t) => ({
          slug: t.slug,
          name: t.name,
          logo: t.meta?.logo ?? "",
          description: trimDescription(t.meta?.description, MAX_APP_DESCRIPTION),
          connected: connected.has(t.slug),
        }));
    },

    async connectLink(ctx, user, app, callbackUrl, opts = {}) {
      const link = await inSession<{ redirect_url: string }>(
        ctx,
        user,
        opts.kind ?? defaultKind,
        "POST",
        "/link",
        { toolkit: app, callback_url: callbackUrl },
      );
      return link.redirect_url;
    },

    async disconnect(ctx, user, app) {
      const account = (await accounts(ctx, user)).get(app);
      if (!account) return false;
      await api(ctx, "DELETE", `/connected_accounts/${enc(account)}`);
      return true;
    },

    async findTriggers(ctx, app, opts = {}) {
      const q = new URLSearchParams({ toolkit_slugs: app, limit: "50" });
      const { items = [] } = await api<Partial<TriggerTypes>>(ctx, "GET", `/triggers_types?${q}`);
      return items
        .filter((t) => !t.requires_webhook_endpoint_setup)
        .slice(0, opts.limit ?? 20)
        .map((t) => {
          const required = new Set(t.config?.required ?? []);
          return {
            slug: t.slug,
            name: t.name,
            description: trimDescription(t.description, MAX_TRIGGER_DESCRIPTION),
            polled: t.type === "poll",
            config: Object.entries(t.config?.properties ?? {}).map(([name, p]) => ({
              name,
              type: p.type ?? "any",
              required: required.has(name),
              ...(p.description
                ? { description: trimDescription(p.description, MAX_FIELD_DESCRIPTION) }
                : {}),
            })),
          };
        });
    },

    async upsertTrigger(ctx, user, slug, config) {
      const { trigger_id } = await api<{ trigger_id: string }>(
        ctx,
        "POST",
        `/trigger_instances/${enc(slug)}/upsert`,
        { user_id: user, trigger_config: config },
      );
      return trigger_id;
    },

    async deleteTrigger(ctx, triggerId) {
      try {
        await api(ctx, "DELETE", `/trigger_instances/manage/${enc(triggerId)}`);
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return false;
        throw err;
      }
    },

    mcpServer({ kind, allowedTools = COMPOSIO_MCP_TOOLS }) {
      configOf(kind);
      return {
        url: async ({ clientId, env, signal }) => {
          if (!clientId) {
            throw new Error("Composio's tools act for one user: no client id given");
          }
          const session = await inSession<{ mcp?: { url?: string } }>(
            { env, signal },
            clientId,
            kind,
            "GET",
            "",
          );
          const url = session.mcp?.url;
          if (!url) throw new Error("Composio's session answered no MCP url");
          return url;
        },
        headers: ({ env }) => ({ "x-api-key": requireEnv({ env }, keyEnv) }),
        allowedTools,
      };
    },
  };
}
