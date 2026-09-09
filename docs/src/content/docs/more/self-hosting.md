---
title: Self-hosting
description: Agents don't require the managed platform.
---

Most people don't need this page. `npm start` already serves the agent on a
port ([Run it locally](/agent/deploy/local/)), and `aai build --target <host>`
covers Vercel, Deno Deploy, and Modal
([Deploy anywhere](/agent/deploy/anywhere/)).

Reach for `createAgentServer()` when you need to own the boot: your own routes,
your own auth, your own process. `@alexkroman1/aai-runtime` is the same engine
`aai dev` runs:

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
  //
  // `DATABASE_URL` is the one entry that is more than a credential — see
  // "Durability is yours to provision" below.
  env: {
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
  },
  clientDir: defaultClientDir(),
  // Where a THIRD PARTY reaches this deployment, which behind a proxy is not
  // the socket it binds. Only `ctx.workflows.publicWebhookUrl()` reads it, and
  // it throws without it rather than minting a URL nobody can dial.
  publicUrl: process.env.PUBLIC_URL,
});

// Binds loopback by default — this server has no request auth of its own.
await server.listen(3000);
```

The runnable version is
[`examples/self-hosted-server`](https://github.com/alexkroman/agent/tree/main/examples/self-hosted-server)
— under thirty lines of code.

## In between

`createProjectServer` from `@alexkroman1/aai-cli/start` sits between the two.
It builds the server and binds nothing, so you decide how it is served.

## Durability is yours to provision

The platform gives an agent somewhere to keep things. Off it, you do, and it is
one variable: with a `DATABASE_URL` in that `env`, session state and durable
workflow runs go to your Postgres; without one they live in **this process's
memory** and a restart forgets them. The boot line says which it picked, so
this is never a guess.

You do not have to migrate it. The tables come with whoever owns the database
and a self-hosted deployment has no migration step to hang them off, so
`createAgentServer()` creates the ones it owns — two for session state, five
for the run journal — before it binds. That is best-effort by design: a role
that may not `CREATE`, because your own migration already made them, gets one
warning and keeps serving. `ensureSessionStateSchema` and
`ensureWorkflowJournalSchema` are exported from `@alexkroman1/aai-runtime` for
exactly that operator, and running them yourself is safe either way.

`PUBLIC_URL` is the other half, and only if a workflow hands a URL to somebody
else. It is where a third party reaches this deployment, which behind a proxy
is not the socket it binds — so it is never sniffed, and
`ctx.workflows.publicWebhookUrl()` throws naming the option rather than minting
a `127.0.0.1` callback that fails days later on someone else's server.

## What doesn't come with you

`run_code` needs the platform's sandbox and refuses outside one. Everything
else — tools, state, workflows, telephony, your own UI — runs the same code,
against infrastructure you supply: the paragraph above is the whole list of
what that means in practice.
