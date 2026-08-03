// A voice agent served entirely from your own Node process — no managed
// platform, no CLI. The same `agent()` definition a deployed agent uses,
// wired to the SDK's runtime and server:
//
//   agent()  →  createRuntime()  →  createServer()  →  listen()
//
// The browser UI is @alexkroman1/aai-ui's prebuilt default client, served
// as static files. Voice sessions connect on `WS /websocket`.
//
// Run it:
//
//   npm install
//   ASSEMBLYAI_API_KEY=… npm start
//
// then open http://127.0.0.1:3000.

import { createRequire } from "node:module";
import path from "node:path";
import { agent, tool } from "@alexkroman1/aai";
import { createRuntime, createServer } from "@alexkroman1/aai/runtime";
import { z } from "zod";

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) {
  console.error("Set ASSEMBLYAI_API_KEY (the default pipeline is all-AssemblyAI).");
  process.exit(1);
}

const myAgent = agent({
  name: "Dice Roller",
  systemPrompt:
    "You are a cheerful dice-rolling assistant. Offer to roll dice and " +
    "report results with a little drama.",
  greeting: "Hi! Name a die — d6, d20, anything — and I'll roll it.",
  tools: {
    roll_die: tool({
      description: "Roll a single die with the given number of sides.",
      parameters: z.object({ sides: z.number().int().min(2).max(1000) }),
      execute: ({ sides }) => ({ rolled: 1 + Math.floor(Math.random() * sides) }),
    }),
  },
});

// The prebuilt browser UI that `aai dev` serves — shipped inside aai-ui.
const require = createRequire(import.meta.url);
const clientDir = path.join(
  path.dirname(require.resolve("@alexkroman1/aai-ui/package.json")),
  "dist",
  "default-client",
);

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
