// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { colorize } from "consola/utils";
import type { Plugin, ViteDevServer } from "vite";
import { loadAgent, resolveServerEnv } from "./lib/server-common.ts";
import { fmtUrl, log, parsePort } from "./lib/ui.ts";

/** Default index.html that loads the internal aai-ui default client. */
const DEFAULT_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AAI Voice Agent</title>
</head>
<body>
  <div id="app"></div>
  <script type="module">
    import "@alexkroman1/aai-ui/styles.css";
    import { App, defineClient } from "@alexkroman1/aai-ui";
    defineClient(App);
  </script>
</body>
</html>
`;

/**
 * Vite plugin that boots the agent backend and proxies WebSocket.
 */
function aaiDevPlugin(cwd: string, port: number): Plugin {
  let backendPort: number;
  let server: { close(): Promise<void> } | null = null;

  return {
    name: "aai-dev",
    apply: "serve",

    config() {
      backendPort = port + 1;
      const target = `http://localhost:${backendPort}`;
      return {
        server: {
          proxy: {
            "/health": target,
            "/websocket": { target, ws: true },
            "/kv": target,
          },
        },
      };
    },

    async configureServer(viteServer: ViteDevServer) {
      const agentDef = await loadAgent(cwd);
      const env = await resolveServerEnv(cwd);

      const { createRuntime, createServer } = await import("@alexkroman1/aai/server");
      const runtime = createRuntime({ agent: agentDef, env });
      const agentServer = createServer({ runtime, name: agentDef.name });
      await agentServer.listen(backendPort);
      server = agentServer;

      viteServer.config.logger.info(`Agent backend on port ${backendPort}`);
    },

    async buildEnd() {
      if (server) {
        await server.close();
        server = null;
      }
    },
  };
}

export async function runDevCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = parsePort(opts.port);
  const agentName = path.basename(path.resolve(opts.cwd));

  // Determine the Vite root: user's project dir if they have index.html,
  // otherwise a temp dir with the default aai-ui client
  let viteRoot: string;
  const userHtml = path.join(opts.cwd, "index.html");

  if (fs.existsSync(userHtml)) {
    viteRoot = opts.cwd;
  } else {
    // Create a temp dir with default client that imports from aai-ui
    viteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aai-dev-"));
    fs.writeFileSync(path.join(viteRoot, "index.html"), DEFAULT_INDEX_HTML);
  }

  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: viteRoot,
    server: { port },
    plugins: [aaiDevPlugin(opts.cwd, port)],
    // Resolve aai-ui from the CLI's node_modules, not the user's project
    ...(viteRoot !== opts.cwd
      ? {
          resolve: {
            alias: {
              "@alexkroman1/aai-ui/styles.css": path.resolve(
                import.meta.dirname,
                "../../aai-ui/styles.css",
              ),
              "@alexkroman1/aai-ui": path.resolve(import.meta.dirname, "../../aai-ui/src/index.ts"),
            },
          },
        }
      : {}),
  });
  await vite.listen();

  log.success(`${colorize("bold", agentName)} running at ${fmtUrl(`http://localhost:${port}`)}`);
  log.info("Press Ctrl-C to stop");
}
