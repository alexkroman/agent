/**
 * Mock platform API server for CLI integration tests.
 *
 * Starts a real HTTP server that implements the AAI platform API surface
 * (deploy, delete, secrets). Records all requests for assertion.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
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

export async function startMockApi(): Promise<MockApi> {
  const requests: RecordedRequest[] = [];
  const secrets: Record<string, string> = {};
  const overrides: Override[] = [];

  function matchOverride(method: string, path: string): Override | undefined {
    return overrides.find(
      (o) => o.method === method && (o.pathPattern === path || path.startsWith(o.pathPattern)),
    );
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on("end", () => resolve(data));
    });
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
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (auth === "Bearer invalid-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid API key" }));
      return;
    }

    // Check overrides first
    const ov = matchOverride(method, path);
    if (ov) {
      res.writeHead(ov.status, { "Content-Type": "application/json" });
      res.end(ov.body);
      return;
    }

    // Route: POST /deploy — slug is optional in body, server generates if missing
    if (method === "POST" && path === "/deploy") {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const slug = (parsed.slug as string) ?? `generated-${Date.now()}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, slug }));
      return;
    }

    // Route: DELETE /{slug}  (but not /{slug}/secret/*)
    if (method === "DELETE" && path.match(/^\/[^/]+$/) && !path.includes("/secret")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Route: GET /{slug}/secret — list secrets
    if (method === "GET" && path.match(/^\/[^/]+\/secret$/)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ vars: Object.keys(secrets) }));
      return;
    }

    // Route: PUT /{slug}/secret — put secret
    if (method === "PUT" && path.match(/^\/[^/]+\/secret$/)) {
      const parsed = JSON.parse(body) as Record<string, string>;
      Object.assign(secrets, parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Route: DELETE /{slug}/secret/{name}
    const secretDeleteMatch = path.match(/^\/[^/]+\/secret\/(.+)$/);
    if (method === "DELETE" && secretDeleteMatch?.[1]) {
      const name = secretDeleteMatch[1];
      delete secrets[name];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Unknown route
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500);
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
