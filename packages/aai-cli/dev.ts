// Copyright 2025 the AAI authors. MIT license.

import { createServer as createViteServer } from "vite";
import { consola, parsePort } from "./_ui.ts";

export async function runDevCommand(opts: {
  cwd: string;
  port: string;
}): Promise<void> {
  const port = parsePort(opts.port);
  const vite = await createViteServer({
    root: opts.cwd,
    server: { port },
  });
  await vite.listen();
  consola.success(`Ready http://localhost:${port}`);
  consola.info("Ctrl-C to quit");
}
