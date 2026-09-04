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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mock server routes are intentionally flat
  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const body = await readBody(req);

    requests.push({ method, path, headers: req.headers, body });

    // Check auth
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }

    if (auth === "Bearer invalid-key") {
      json(res, 401, { error: "Invalid API key" });
      return;
    }

    // Check overrides first
    const ov = matchOverride(method, path);
    if (ov) {
      send(res, ov.status, ov.body);
      return;
    }

    // Route: POST /deploy — slug is optional in body, server generates if missing
    if (method === "POST" && path === "/deploy") {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const slug = (parsed.slug as string) ?? `generated-${Date.now()}`;
      json(res, 200, { ok: true, slug });
      return;
    }

    // Route: DELETE /{slug}  (but not /{slug}/secret/*)
    if (method === "DELETE" && path.match(/^\/[^/]+$/) && !path.includes("/secret")) {
      json(res, 200, { ok: true });
      return;
    }

    // Route: GET /{slug}/secret — list secrets
    if (method === "GET" && path.match(/^\/[^/]+\/secret$/)) {
      json(res, 200, { vars: Object.keys(secrets) });
      return;
    }

    // Route: PUT /{slug}/secret — put secret
    if (method === "PUT" && path.match(/^\/[^/]+\/secret$/)) {
      const parsed = JSON.parse(body) as Record<string, string>;
      Object.assign(secrets, parsed);
      json(res, 200, { ok: true });
      return;
    }

    // Route: DELETE /{slug}/secret/{name}
    const secretDeleteMatch = path.match(/^\/[^/]+\/secret\/(.+)$/);
    if (method === "DELETE" && secretDeleteMatch?.[1]) {
      const name = secretDeleteMatch[1];
      delete secrets[name];
      json(res, 200, { ok: true });
      return;
    }

    // Unknown route
    json(res, 404, { error: "Not found" });
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
