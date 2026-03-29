// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import * as p from "@clack/prompts";
import { colorize } from "consola/utils";
import { createServer as createViteServer } from "vite";
import { consola, parsePort } from "./_ui.ts";

export async function runDevCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = parsePort(opts.port);
  const agentName = path.basename(path.resolve(opts.cwd));
  const vite = await createViteServer({
    root: opts.cwd,
    server: { port },
  });
  await vite.listen();

  const url = colorize("blueBright", `http://localhost:${port}`);
  p.note(`Agent:  ${colorize("bold", agentName)}\nLocal:  ${url}`, "aai dev");
  consola.info("Press Ctrl-C to stop");
}
