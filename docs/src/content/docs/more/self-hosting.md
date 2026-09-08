---
title: Self-hosting
description: Agents don't require the managed platform.
---

`@alexkroman1/aai-runtime` is the same engine `aai dev` runs. Define an agent,
build a runtime, and serve voice sessions from your own Node process:

```ts
import { agent } from "@alexkroman1/aai";
import { createAgentServer, withToolsDir } from "@alexkroman1/aai-runtime";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";

// Every file in `tools/` is a tool. This line is the whole registration —
// on the platform the CLI's bundler does the same enumeration at build time.
const served = await withToolsDir(
  agent({ name: "My Agent" }),
  new URL("./tools/", import.meta.url),
);

const server = createAgentServer({
  agent: served,
  // What tool code sees as `ctx.env`, and where provider credentials resolve
  // from. Nothing falls back to the host's process.env on its own.
  env: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
  clientDir: defaultClientDir(),
});

// Binds loopback by default — this server has no request auth of its own.
await server.listen(3000);
```

The runnable version is
[`examples/self-hosted-server`](https://github.com/alexkroman/agent/tree/main/examples/self-hosted-server)
— about seventy lines.

## The simpler option first

If you just want the agent on a port, `npm start` in a scaffolded project
already does that — see [Run it locally](/agent/deploy/local/). Reach for
`createAgentServer()` when you need to own the boot: your own routes, your own
auth, your own process.

`createProjectServer` from `@alexkroman1/aai-cli/start` sits between the two.
It builds the server and binds nothing, so you decide how it is served.

## What doesn't come with you

`run_code` needs the platform's sandbox and refuses outside one. Everything
else — tools, state, workflows, telephony, your own UI — runs the same.
