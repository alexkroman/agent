// A self-hosted, multi-tenant voice agent server.
//
// It ships with no agent. Callers deploy one INTO it, per connection: each
// `WS /websocket?host=1` opens with a `config` frame carrying the system
// prompt, the tool schemas, and the provider credentials that session should
// run on. The server supplies the voice pipeline and nothing else.
//
//   caller  ──> { type: "config", host: { systemPrompt, tools, credentials } }
//           <── { type: "tool_call", toolCallId, toolName, args }
//           ──> { type: "tool_result", toolCallId, result }
//
// Two properties make that safe to expose self-serve. The server holds no
// provider credentials, so an unauthenticated caller has none to spend — every
// session runs on the key its own caller sent. And tool schemas are not tool
// code: each call is relayed back over the socket for the caller to execute,
// so no tenant code runs in this process.
//
//   npm install && npm start

import { createHostServer } from "@alexkroman1/aai/runtime";

const server = createHostServer();

const port = Number(process.env.PORT ?? 3000);

// Loopback by default. Host mode authenticates the caller's provider KEY, not
// the caller: it stops key theft, not abuse — anyone who can reach the port
// can open a session on their own dime and consume your CPU and sockets. Put
// your own authentication in front before exposing it, either a reverse proxy
// or the `upgrade` hook (see README).
await server.listen(port);
console.log(`Host server listening on ws://127.0.0.1:${port}/websocket?host=1`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
