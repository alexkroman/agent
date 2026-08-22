// Deploy an agent template to your own Node process — no managed platform, no
// `aai` CLI.
//
// `agent.ts` next to this file is the `simple` template verbatim, untouched.
// This file is the deployment.
//
// Tools declared on the agent run IN THIS PROCESS, on your credentials — the
// opposite arrangement from `examples/host-server`, where callers bring their
// own agent and execute their own tools.
//
// Run it:
//
//   npm install
//   export ASSEMBLYAI_API_KEY=…
//   npm start
//
// then open http://127.0.0.1:3000.

import { createAgentServer } from "@alexkroman1/aai-runtime";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";
// Node 24 strips the types natively, so the template's `.ts` is imported as-is
// — no build step, and no second copy of the agent in JavaScript that could
// drift from the one you deploy.
import agent from "./agent.ts";

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) {
  console.error("Set ASSEMBLYAI_API_KEY (the default pipeline is all-AssemblyAI).");
  process.exit(1);
}

// `env` is what tool code sees as `ctx.env`, and where provider credentials are
// resolved from. On the platform this comes from `aai secret put`; here it is
// yours to assemble — from a vault, a mounted file, whatever you already use.
// Nothing falls back to the host's process.env on its own.
const server = createAgentServer({
  agent,
  env: { ASSEMBLYAI_API_KEY: apiKey },
  // The prebuilt browser UI that `aai dev` serves, shipped inside aai-ui.
  clientDir: defaultClientDir(),
});

// listen() binds loopback by default — the server has no request auth of its
// own. Behind your own reverse proxy / auth, pass "0.0.0.0" to expose it.
await server.listen(Number(process.env.PORT ?? 3000));
console.log(`${agent.name} listening on http://127.0.0.1:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  // close() shuts the runtime down too — no separate runtime.shutdown().
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
