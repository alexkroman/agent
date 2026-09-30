// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { composio } from "./composio.ts";
import {
  COMPOSIO_BASE_URL,
  COMPOSIO_MCP_TOOLS,
  type ComposioSessionStore,
  composioErrorMessage,
} from "./composio-api.ts";
import { HttpError } from "./json-client.ts";
import type { McpResolveContext } from "./mcp-config.ts";
import {
  type FetchRouteHandler,
  type FetchRouteRequest,
  type StubFetchRoutes,
  stubFetchRoutes,
} from "./testing-fetch-routes.ts";

// Composio behind a fake route table: what these pin is that a user's session
// is made once and reused, a session Composio lost is made again once, a
// request refusal is a failed result while a key/rate refusal throws, the apps
// listed are filtered to the user's own ACTIVE accounts, and no error carries
// the API key.

const KEY = "ak_test_secret";
const env = { COMPOSIO_API_KEY: KEY };
const ctx = { env };
const HOST = new URL(COMPOSIO_BASE_URL).host;
const BASE_PATH = new URL(COMPOSIO_BASE_URL).pathname;
const path = (req: FetchRouteRequest) => req.pathname.replace(BASE_PATH, "");

let net: StubFetchRoutes | undefined;
afterEach(() => net?.restore());

function serve(handler: FetchRouteHandler) {
  net = stubFetchRoutes({ [HOST]: handler });
  return net;
}
const hits = (p: string, method?: string) =>
  (net?.to(HOST) ?? []).filter((h) => path(h) === p && (!method || h.method === method));

function refusal(status: number, message: string, extra: Record<string, unknown> = {}) {
  return { status, body: { error: { message, ...extra } } };
}

describe("composioErrorMessage", () => {
  test("keeps the message, which fields failed, and the request id", () => {
    expect(
      composioErrorMessage({
        error: {
          message: "Validation error",
          errors: ["tool_slug: required", "arguments: expected object"],
          request_id: "req_9",
        },
      }),
    ).toBe("Validation error: tool_slug: required; arguments: expected object (request req_9)");
    expect(composioErrorMessage({ error: { message: "Nope" } })).toBe("Nope");
    expect(composioErrorMessage({ message: "flat" })).toBeUndefined();
  });

  test("a refusal throws an HttpError carrying that detail, and never the key", async () => {
    serve(() =>
      refusal(400, `bad key ${KEY}`, { errors: ["user_id: missing"], request_id: "req_1" }),
    );
    const apps = composio();
    const err = await apps.api(ctx, "GET", "/toolkits").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const http = err as HttpError;
    expect(http.status).toBe(400);
    expect(http.message).toBe("Composio 400: bad key [redacted]: user_id: missing (request req_1)");
    expect(JSON.stringify(http.body)).not.toContain(KEY);
    // The key went out as the header, and only there.
    expect(net?.hits[0]?.headers["x-api-key"]).toBe(KEY);
  });

  test("a baseUrl that is not https is refused at construction", () => {
    expect(() => composio({ baseUrl: "http://backend.composio.dev/api/v3.1" })).toThrow(/https/);
  });
});

describe("sessions", () => {
  test("made once per user and kind with the kind's config, then reused", async () => {
    serve((req) =>
      path(req) === "/tool_router/session"
        ? { status: 201, body: { session_id: "trs_1" } }
        : { body: { data: { ok: 1 }, error: null, log_id: "log_1" } },
    );
    const set: string[] = [];
    const store: ComposioSessionStore = {
      get: () => undefined,
      set: (user, kind, id) => void set.push(`${kind}:${user}=${id}`),
      delete: () => undefined,
    };
    const apps = composio({
      sessions: { voice: {}, background: { workbench: true } },
      sessionStore: store,
    });
    const [a, b] = await Promise.all([
      apps.execute(ctx, "u1", "GMAIL_FETCH_EMAILS", {}),
      apps.execute(ctx, "u1", "GMAIL_FETCH_EMAILS", {}),
    ]);
    expect(a).toEqual({ ok: true, data: { ok: 1 }, logId: "log_1" });
    expect(b).toEqual(a);
    const created = hits("/tool_router/session");
    expect(created).toHaveLength(1);
    expect(created[0]?.json).toEqual({
      user_id: "u1",
      manage_connections: { enable: false },
      workbench: { enable: false },
    });
    expect(hits("/tool_router/session/trs_1/execute")).toHaveLength(2);
    expect(set).toEqual(["voice:u1=trs_1"]);

    await apps.execute(ctx, "u1", "X", {}, { kind: "background" });
    expect(hits("/tool_router/session")[1]?.json).toMatchObject({ workbench: { enable: true } });
  });

  test("a stored session id is used without creating one", async () => {
    serve(() => ({ body: { data: 1, log_id: "l" } }));
    const apps = composio({
      sessionStore: { get: () => "trs_stored", set: () => undefined, delete: () => undefined },
    });
    await apps.execute(ctx, "u1", "X", {});
    expect(hits("/tool_router/session")).toHaveLength(0);
    expect(hits("/tool_router/session/trs_stored/execute")).toHaveLength(1);
  });

  test("a 404 naming the session forgets it and makes a new one, once", async () => {
    let n = 0;
    serve((req) => {
      if (path(req) === "/tool_router/session") {
        return { status: 201, body: { session_id: `trs_${++n}` } };
      }
      if (path(req) === "/tool_router/session/trs_1/execute") {
        return refusal(404, "Session not found");
      }
      return { body: { data: "ok", log_id: "l2" } };
    });
    const deleted: string[] = [];
    const memory = new Map<string, string>();
    const apps = composio({
      sessionStore: {
        get: (u, k) => memory.get(`${k}:${u}`),
        set: (u, k, id) => void memory.set(`${k}:${u}`, id),
        delete: (u, k) => {
          deleted.push(`${k}:${u}`);
          memory.delete(`${k}:${u}`);
        },
      },
    });
    expect(await apps.execute(ctx, "u1", "X", {})).toEqual({ ok: true, data: "ok", logId: "l2" });
    expect(deleted).toEqual(["default:u1"]);
    expect(memory.get("default:u1")).toBe("trs_2");
    // Reused from here on.
    await apps.execute(ctx, "u1", "X", {});
    expect(hits("/tool_router/session")).toHaveLength(2);
  });

  test("a 404 that does not name the session is not a lost session", async () => {
    serve((req) =>
      path(req) === "/tool_router/session"
        ? { status: 201, body: { session_id: "trs_1" } }
        : refusal(404, "Tool GMAIL_NOPE not found"),
    );
    const apps = composio();
    const out = await apps.execute(ctx, "u1", "GMAIL_NOPE", {});
    expect(out).toEqual({ ok: false, error: "Composio 404: Tool GMAIL_NOPE not found" });
    expect(hits("/tool_router/session")).toHaveLength(1);
  });

  test("a failed create is not remembered", async () => {
    let fail = true;
    serve((req) => {
      if (path(req) === "/tool_router/session") {
        if (fail) return refusal(500, "down");
        return { status: 201, body: { session_id: "trs_1" } };
      }
      return { body: { data: 1, log_id: "l" } };
    });
    const apps = composio();
    await expect(apps.execute(ctx, "u1", "X", {})).rejects.toThrow("Composio 500: down");
    fail = false;
    expect((await apps.execute(ctx, "u1", "X", {})).ok).toBe(true);
  });

  test("an undeclared kind is refused by name", async () => {
    const apps = composio({ sessions: { voice: {} } });
    // @ts-expect-error — not a declared kind
    expect(() => apps.mcpServer({ kind: "background" })).toThrow(/background.*voice/);
  });
});

describe("execute", () => {
  const withExecute = (answer: ReturnType<FetchRouteHandler>) =>
    serve((req) =>
      path(req) === "/tool_router/session"
        ? { status: 201, body: { session_id: "trs_1" } }
        : answer,
    );

  test("sends the slug and arguments, and an action's own error is a failed result", async () => {
    withExecute({ body: { data: null, error: "Recipient invalid", log_id: "log_e" } });
    const out = await composio().execute(ctx, "u1", "GMAIL_SEND_EMAIL", { to: "x" });
    expect(out).toEqual({ ok: false, error: "Recipient invalid", logId: "log_e" });
    expect(hits("/tool_router/session/trs_1/execute")[0]?.json).toEqual({
      tool_slug: "GMAIL_SEND_EMAIL",
      arguments: { to: "x" },
    });
  });

  test.each([400, 404, 409, 422])("a %i refusal of the request is a failed result", async (s) => {
    withExecute(refusal(s, "No connected account", { request_id: "r" }));
    expect(await composio().execute(ctx, "u1", "X", {})).toEqual({
      ok: false,
      error: `Composio ${s}: No connected account (request r)`,
    });
  });

  test.each([401, 403, 429, 500, 503])("a %i throws", async (s) => {
    withExecute(refusal(s, "stop"));
    await expect(composio().execute(ctx, "u1", "X", {})).rejects.toBeInstanceOf(HttpError);
  });

  test("a missing key throws naming the variable, not calling out", async () => {
    serve(() => ({ body: {} }));
    await expect(composio().execute({ env: {} }, "u1", "X", {})).rejects.toThrow(
      /COMPOSIO_API_KEY/,
    );
    expect(net?.hits).toHaveLength(0);
  });
});

describe("listApps / connectLink / disconnect", () => {
  const toolkit = (slug: string, over: Record<string, unknown> = {}) => ({
    slug,
    name: slug.toUpperCase(),
    no_auth: false,
    meta: { logo: `https://logo/${slug}`, description: `  The ${slug}\n\n app  ` },
    ...over,
  });
  const accounts = {
    items: [
      { id: "ca_gmail", user_id: "u1", status: "ACTIVE", toolkit: { slug: "gmail" } },
      { id: "ca_other", user_id: "u2", status: "ACTIVE", toolkit: { slug: "slack" } },
      { id: "ca_dead", user_id: "u1", status: "EXPIRED", toolkit: { slug: "notion" } },
    ],
  };

  test("catalog search: no-auth apps dropped, descriptions flattened and trimmed", async () => {
    serve((req) => {
      if (path(req) === "/connected_accounts") return { body: accounts };
      return {
        body: {
          items: [
            toolkit("gmail"),
            toolkit("slack"),
            toolkit("notion"),
            toolkit("weather", { no_auth: true }),
            toolkit("long", { meta: { logo: "", description: "x".repeat(500) } }),
          ],
        },
      };
    });
    const apps = await composio().listApps(ctx, "u1", { search: "mail" });
    expect(apps.map((a) => [a.slug, a.connected])).toEqual([
      ["gmail", true],
      // Another user's account and an inactive one do not count.
      ["slack", false],
      ["notion", false],
      ["long", false],
    ]);
    expect(apps[0]?.description).toBe("The gmail app");
    expect(apps[3]?.description).toHaveLength(240);
    const q = hits("/connected_accounts")[0]?.searchParams;
    expect(q?.get("user_ids")).toBe("u1");
    expect(q?.get("statuses")).toBe("ACTIVE");
    const t = hits("/toolkits")[0]?.searchParams;
    expect(t?.get("search")).toBe("mail");
    expect(t?.get("limit")).toBe("20");
  });

  test("connectedOnly reads each connected app's toolkit", async () => {
    serve((req) => {
      if (path(req) === "/connected_accounts") return { body: accounts };
      if (path(req) === "/toolkits/gmail") return { body: toolkit("gmail") };
    });
    const apps = await composio().listApps(ctx, "u1", { connectedOnly: true });
    expect(apps.map((a) => a.slug)).toEqual(["gmail"]);
  });

  test("connectLink asks the session for the app's hosted page", async () => {
    serve((req) =>
      path(req) === "/tool_router/session"
        ? { status: 201, body: { session_id: "trs_1" } }
        : { body: { redirect_url: "https://connect.composio.dev/x" } },
    );
    const url = await composio().connectLink(ctx, "u1", "gmail", "https://app.test/back");
    expect(url).toBe("https://connect.composio.dev/x");
    expect(hits("/tool_router/session/trs_1/link")[0]?.json).toEqual({
      toolkit: "gmail",
      callback_url: "https://app.test/back",
    });
  });

  test("disconnect only reaches the user's own account", async () => {
    serve((req) => {
      if (path(req) === "/connected_accounts") return { body: accounts };
      if (req.method === "DELETE") return { status: 204 };
    });
    const apps = composio();
    expect(await apps.disconnect(ctx, "u1", "slack")).toBe(false);
    expect(await apps.disconnect(ctx, "u1", "gmail")).toBe(true);
    expect(
      net
        ?.to(HOST)
        .filter((h) => h.method === "DELETE")
        .map(path),
    ).toEqual(["/connected_accounts/ca_gmail"]);
  });
});

describe("triggers", () => {
  test("findTriggers drops hand-registered webhooks and shapes the config", async () => {
    serve(() => ({
      body: {
        items: [
          {
            slug: "GMAIL_NEW_GMAIL_MESSAGE",
            name: "New email",
            description: "Fires on\n a new   email",
            type: "poll",
            config: {
              properties: { labelIds: { type: "string", description: "Label" }, interval: {} },
              required: ["labelIds"],
            },
          },
          {
            slug: "SLACK_EVENT",
            name: "Slack",
            description: "",
            type: "webhook",
            requires_webhook_endpoint_setup: true,
          },
          { slug: "GITHUB_PR", name: "PR", description: "d", type: "webhook" },
        ],
      },
    }));
    const found = await composio().findTriggers(ctx, "gmail", { limit: 5 });
    expect(found).toEqual([
      {
        slug: "GMAIL_NEW_GMAIL_MESSAGE",
        name: "New email",
        description: "Fires on a new email",
        polled: true,
        config: [
          { name: "labelIds", type: "string", required: true, description: "Label" },
          { name: "interval", type: "any", required: false },
        ],
      },
      { slug: "GITHUB_PR", name: "PR", description: "d", polled: false, config: [] },
    ]);
    expect(net?.hits[0]?.searchParams.get("toolkit_slugs")).toBe("gmail");
    expect(await composio().findTriggers(ctx, "gmail", { limit: 1 })).toHaveLength(1);
  });

  test("upsertTrigger answers the trigger id; deleteTrigger tolerates a 404", async () => {
    serve((req) => {
      if (req.method === "POST") return { body: { trigger_id: "ti_1" } };
      if (path(req) === "/trigger_instances/manage/ti_gone") return refusal(404, "gone");
      if (path(req) === "/trigger_instances/manage/ti_err") return refusal(500, "down");
      return { body: {} };
    });
    const apps = composio();
    expect(await apps.upsertTrigger(ctx, "u1", "GMAIL_NEW", { labelIds: "INBOX" })).toBe("ti_1");
    expect(hits("/trigger_instances/GMAIL_NEW/upsert")[0]?.json).toEqual({
      user_id: "u1",
      trigger_config: { labelIds: "INBOX" },
    });
    expect(await apps.deleteTrigger(ctx, "ti_1")).toBe(true);
    expect(await apps.deleteTrigger(ctx, "ti_gone")).toBe(false);
    await expect(apps.deleteTrigger(ctx, "ti_err")).rejects.toThrow("Composio 500");
  });
});

describe("mcpServer", () => {
  const resolve = (clientId: string | undefined): McpResolveContext => ({
    clientId,
    env,
    signal: new AbortController().signal,
  });

  test("the user's session's MCP url, the key header, and the meta tools", async () => {
    serve((req) =>
      path(req) === "/tool_router/session"
        ? { status: 201, body: { session_id: "trs_bg" } }
        : { body: { mcp: { url: "https://mcp.composio.dev/trs_bg" } } },
    );
    const apps = composio({ sessions: { voice: {}, background: { workbench: true } } });
    const server = apps.mcpServer({ kind: "background" });
    expect(server.allowedTools).toEqual(COMPOSIO_MCP_TOOLS);
    const url = typeof server.url === "function" ? await server.url(resolve("u1")) : server.url;
    expect(url).toBe("https://mcp.composio.dev/trs_bg");
    expect(hits("/tool_router/session")[0]?.json).toMatchObject({
      user_id: "u1",
      workbench: { enable: true },
    });
    const headers =
      typeof server.headers === "function" ? await server.headers(resolve("u1")) : server.headers;
    expect(headers).toEqual({ "x-api-key": KEY });
    expect(
      apps.mcpServer({ kind: "voice", allowedTools: ["COMPOSIO_SEARCH_TOOLS"] }).allowedTools,
    ).toEqual(["COMPOSIO_SEARCH_TOOLS"]);
  });

  test("with no client id it throws rather than acting for nobody", async () => {
    serve(() => undefined);
    const server = composio().mcpServer({ kind: "default" });
    if (typeof server.url !== "function") throw new Error("expected a resolver");
    await expect(Promise.resolve(server.url(resolve(undefined)))).rejects.toThrow(/client id/);
    expect(net?.hits).toHaveLength(0);
  });
});
