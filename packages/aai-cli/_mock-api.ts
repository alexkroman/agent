// Mock platform API server for CLI integration tests. Implements the AAI
// platform API (deploy, delete, secrets) and records all requests for assertion.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockApi {
  url: string;
  requests: RecordedRequest[];
  secrets: Record<string, string>;
  override(method: string, pathPattern: string, status: number, body?: string): void;
  clear(): void;
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

    function reply(status: number, payload: unknown): void {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    }

    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply(401, { error: "Unauthorized" });
    if (auth === "Bearer invalid-key") return reply(401, { error: "Invalid API key" });

    const ov = matchOverride(method, path);
    if (ov) return reply(ov.status, ov.body);

    if (method === "POST" && path === "/deploy") {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const slug = (parsed.slug as string) ?? `generated-${Date.now()}`;
      return reply(200, { ok: true, slug });
    }

    // DELETE /{slug} — but exclude /{slug}/secret/* below
    if (method === "DELETE" && path.match(/^\/[^/]+$/) && !path.includes("/secret")) {
      return reply(200, { ok: true });
    }

    if (method === "GET" && path.match(/^\/[^/]+\/secret$/)) {
      return reply(200, { vars: Object.keys(secrets) });
    }

    if (method === "PUT" && path.match(/^\/[^/]+\/secret$/)) {
      Object.assign(secrets, JSON.parse(body) as Record<string, string>);
      return reply(200, { ok: true });
    }

    const secretDeleteMatch = path.match(/^\/[^/]+\/secret\/(.+)$/);
    if (method === "DELETE" && secretDeleteMatch?.[1]) {
      delete secrets[secretDeleteMatch[1]];
      return reply(200, { ok: true });
    }

    reply(404, { error: "Not found" });
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
