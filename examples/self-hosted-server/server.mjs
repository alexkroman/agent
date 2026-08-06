// Deploy an agent template to your own Node process — no managed platform, no
// `aai` CLI.
//
// `agent.ts` next to this file is the `simple` template verbatim, untouched.
// This file is the deployment: the three SDK calls the CLI's `aai dev` wraps,
// called directly.
//
//   agent.ts  →  createRuntime()  →  createServer()  →  listen()
//
// Tools declared on the agent run IN THIS PROCESS, on your credentials —
// the opposite arrangement from `examples/host-server`, where callers bring
// their own agent and execute their own tools.
//
// The browser UI is @alexkroman1/aai-ui's prebuilt default client, served as
// static files. Voice sessions connect on `WS /websocket`.
//
// Run it:
//
//   npm install
//   export ASSEMBLYAI_API_KEY=…
//   npm start
//
// then open http://127.0.0.1:3000.

import { createRequire } from "node:module";
import path from "node:path";
import { createRuntime, createServer } from "@alexkroman1/aai/runtime";
// Node 24 strips the types natively, so the template's `.ts` is imported
// as-is — no build step, and no second copy of the agent in JavaScript that
// could drift from the one you deploy.
import myAgent from "./agent.ts";

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) {
  console.error("Set ASSEMBLYAI_API_KEY (the default pipeline is all-AssemblyAI).");
  process.exit(1);
}

// The prebuilt browser UI that `aai dev` serves — shipped inside aai-ui.
const require = createRequire(import.meta.url);
const clientDir = path.join(
  path.dirname(require.resolve("@alexkroman1/aai-ui/package.json")),
  "dist",
  "default-client",
);

// `env` is what tool code sees as `ctx.env`, and where provider credentials
// are resolved from. On the platform this comes from `aai secret put`; here it
// is yours to assemble — from a vault, a mounted file, whatever you already
// use. Nothing falls back to the host's process.env on its own.
const runtime = createRuntime({
  agent: myAgent,
  env: { ASSEMBLYAI_API_KEY: apiKey },
});

const server = createServer({
  runtime,
  name: myAgent.name,
  greeting: myAgent.greeting,
  clientDir,
});

const port = Number(process.env.PORT ?? 3000);
// listen() binds loopback by default — the server has no request auth of its
// own. Behind your own reverse proxy / auth, pass "0.0.0.0" to expose it.
await server.listen(port);
console.log(`${myAgent.name} listening on http://127.0.0.1:${port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    await runtime.shutdown();
    process.exit(0);
  });
}
