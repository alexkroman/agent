/**
 * Mock platform API server for CLI integration tests.
 *
 * Starts a real HTTP server that implements the AAI platform API surface
 * (deploy, delete, secrets). Records all requests for assertion.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { gunzipSync } from "node:zlib";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Decoded body text (inflated first when sent with Content-Encoding: gzip). */
  body: string;
}

export interface MockApi {
  /** Base URL of the mock server (http://localhost:<port>) */
  url: string;
  /** All recorded requests */
  requests: RecordedRequest[];
  /** Secrets currently stored */
  secrets: Record<string, string>;
  /** Override response for a specific method+path pattern */
  override(method: string, pathPattern: string, status: number, body?: string): void;
  /** Clear recorded requests */
  clear(): void;
  /** Stop the server */
  stop(): Promise<void>;
}

type Override = { method: string; pathPattern: string; status: number; body: string };

/** Every response this server sends is JSON — one place says so. */
function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

/** {@link send} for a value that still has to be serialized. */
function json(res: ServerResponse, status: number, payload: unknown): void {
  send(res, status, JSON.stringify(payload));
}

export async function startMockApi(): Promise<MockApi> {
  const requests: RecordedRequest[] = [];
  const secrets: Record<string, string> = {};
  const overrides: Override[] = [];

  function matchOverride(method: string, path: string): Override | undefined {
    return overrides.find(
      (o) => o.method === method && (o.pathPattern === path || path.startsWith(o.pathPattern)),
    );
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    // buffer() settles on failure paths too — a socket error or client abort
    // destroys the stream and rejects, so the handler (and the test awaiting
    // it) can never hang. gunzipSync throws on garbage, rejecting likewise.
    const raw = await buffer(req);
    // Mirror the platform server: transparently inflate gzipped uploads
    // (the CLI compresses deploy bodies).
    const inflated = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
    return inflated.toString("utf-8");
  }

  /** The 401 message for a request this server refuses, or undefined to admit it. */
  function authError(auth: string | undefined): string | undefined {
    if (!auth?.startsWith("Bearer ")) return "Unauthorized";
    if (auth === "Bearer invalid-key") return "Invalid API key";
    return undefined;
  }

  type Reply = { status: number; payload: unknown };

  /** The agent routes (deploy, delete), or undefined when none matches. */
  function agentRoute(method: string, path: string, body: string): Reply | undefined {
    // Route: POST /deploy — slug is optional in body, server generates if missing
    if (method === "POST" && path === "/deploy") {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const slug = (parsed.slug as string) ?? `generated-${Date.now()}`;
      return { status: 200, payload: { ok: true, slug } };
    }

    // Route: DELETE /{slug}  (but not /{slug}/secret/*)
    if (method === "DELETE" && path.match(/^\/[^/]+$/) && !path.includes("/secret")) {
      return { status: 200, payload: { ok: true } };
    }
    return undefined;
  }

  /** The secret routes, or undefined when none matches. */
  function secretRoute(method: string, path: string, body: string): Reply | undefined {
    // Route: GET /{slug}/secret — list secrets
    if (method === "GET" && path.match(/^\/[^/]+\/secret$/)) {
      return { status: 200, payload: { vars: Object.keys(secrets) } };
    }

    // Route: PUT /{slug}/secret — put secret
    if (method === "PUT" && path.match(/^\/[^/]+\/secret$/)) {
      const parsed = JSON.parse(body) as Record<string, string>;
      Object.assign(secrets, parsed);
      return { status: 200, payload: { ok: true } };
    }

    // Route: DELETE /{slug}/secret/{name}
    const secretDeleteMatch = path.match(/^\/[^/]+\/secret\/(.+)$/);
    if (method === "DELETE" && secretDeleteMatch?.[1]) {
      const name = secretDeleteMatch[1];
      delete secrets[name];
      return { status: 200, payload: { ok: true } };
    }
    return undefined;
  }

  const NOT_FOUND: Reply = { status: 404, payload: { error: "Not found" } };

  /** The built-in routes, for a request no override matched; 404 for an unknown one. */
  function route(method: string, path: string, body: string): Reply {
    return agentRoute(method, path, body) ?? secretRoute(method, path, body) ?? NOT_FOUND;
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const body = await readBody(req);

    requests.push({ method, path, headers: req.headers, body });

    // Check auth
    const refused = authError(req.headers.authorization);
    if (refused) {
      json(res, 401, { error: refused });
      return;
    }

    // Check overrides first
    const ov = matchOverride(method, path);
    if (ov) {
      send(res, ov.status, ov.body);
      return;
    }

    const { status, payload } = route(method, path, body);
    json(res, status, payload);
  }

  const server: Server = createServer((req, res) => {
    // Bad JSON in a route body (JSON.parse throws) lands here as a 500.
    handler(req, res).catch((err) => {
      // Headers may already be out when the failure hit mid-response;
      // writeHead would then throw ERR_HTTP_HEADERS_SENT and crash the test.
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    secrets,
    override(method: string, pathPattern: string, status: number, body = "{}") {
      overrides.push({ method, pathPattern, status, body });
    },
    clear() {
      requests.length = 0;
      overrides.length = 0;
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
