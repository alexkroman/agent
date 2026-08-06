// Minimal server for the vanilla Dispatch Command Center.
//
// Built entirely on Node's standard library — no Express, no `ws`, no SDK. It
// does exactly two things:
//
//   1. GET /token  — mints a short-lived AssemblyAI Voice Agent token so the
//                     browser can connect directly to the agent WebSocket
//                     WITHOUT ever seeing the secret API key.
//   2. everything else — serves the static files in ./public.
//
// The ASSEMBLYAI_API_KEY never leaves this process; the browser only receives
// a single-use token that expires in a few minutes.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ASSEMBLYAI_API_KEY;
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TOKEN_ENDPOINT = "https://agents.assemblyai.com/v1/token";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function handleToken(res) {
  if (!API_KEY) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "ASSEMBLYAI_API_KEY is not set on the server" }));
    return;
  }
  const url = new URL(TOKEN_ENDPOINT);
  // Redemption window to open the socket; session length cap once connected.
  url.searchParams.set("expires_in_seconds", "120");
  url.searchParams.set("max_session_duration_seconds", "3600");

  try {
    const upstream = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
    const body = await upstream.text();
    if (!upstream.ok) {
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Token mint failed: ${body}` }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body); // already { "token": "..." }
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Token request error: ${err.message}` }));
  }
}

async function serveStatic(pathname, res) {
  // Resolve safely inside PUBLIC_DIR — reject path traversal.
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === "/token") {
    void handleToken(res);
  } else {
    void serveStatic(pathname, res);
  }
});

server.listen(PORT, () => {
  console.log(`Dispatch Command Center → http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn("⚠  ASSEMBLYAI_API_KEY is not set — /token will return 500 until you set it.");
  }
});
