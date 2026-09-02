import { createServer as createHttp } from "node:http";
import { createServer as createVite } from "vite";
import { viteDevConfig } from "./_dev-vite-config.ts";

const backend = createHttp((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ backend: true, url: req.url }));
});
await new Promise<void>((r) => backend.listen(3901, "127.0.0.1", r));

const vite = await createVite(viteDevConfig("/tmp/aai-repro-j1/proj", 3900, 3901));
await vite.listen();
console.log("vite address:", JSON.stringify(vite.httpServer?.address()));
console.log("resolved server.host:", JSON.stringify(vite.config.server.host));

for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
  for (const p of ["/workflows/stitch.ts", "/workflows/runs", "/client.tsx"]) {
    try {
      const res = await fetch(`http://${host}:3900${p}`);
      const body = await res.text();
      console.log(`GET ${host}${p} -> ${res.status} ${res.headers.get("content-type")} :: ${body.slice(0, 120).replace(/\n/g, " ")}`);
    } catch (e) {
      console.log(`GET ${host}${p} -> ERROR ${(e as Error).cause ?? e}`);
    }
  }
}
await vite.close();
backend.close();
