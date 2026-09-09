---
title: Self-hosting
description: Run an agent as your own Node process, with your own routes and auth.
---

Most people don't need this page. `npm start` already serves the agent on a
port ([Run it locally](/agent/deploy/local/)), and `aai build --target <host>`
covers Vercel, Deno Deploy, and Modal
([Deploy anywhere](/agent/deploy/anywhere/)). Come here when you need to own the
boot — your own routes, your own auth, your own process.

`@alexkroman1/aai-runtime` is the same engine `aai dev` runs, and
`createAgentServer()` is how you build it yourself:

```ts
import { agent } from "@alexkroman1/aai";
import { createAgentServer, withToolsDir } from "@alexkroman1/aai-runtime";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";

const served = await withToolsDir(
  agent({ name: "My Agent" }),
  new URL("./tools/", import.meta.url),
);

const server = createAgentServer({
  agent: served,
  env: {
    ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
  },
  clientDir: defaultClientDir(),
  publicUrl: process.env.PUBLIC_URL,
});

await server.listen(3000);
```

`agent` and `env` are the only required options. Four lines carry the whole
difference from a managed deploy:

- **`withToolsDir`** is the entire tool registration — every file in `tools/` is
  a tool. On the platform the CLI's bundler does the same enumeration at build
  time.
- **`env`** is what tool code sees as `ctx.env`, and where provider credentials
  resolve from. Nothing falls back to the host's `process.env` on its own.
  `DATABASE_URL` is the one entry that is more than a credential — see
  "Durability is yours to provision" below.
- **`publicUrl`** is where a third party reaches this deployment. Only
  `ctx.workflows.publicWebhookUrl(token)` reads it.
- **`server.listen(3000)`** binds `127.0.0.1` unless you pass a second argument.
  This server has no request auth of its own.

The runnable version is
[`examples/self-hosted-server`](https://github.com/alexkroman/agent/tree/main/examples/self-hosted-server)
— under thirty lines of code.

## Keeping the project's boot but owning the socket

`createProjectServer` from `@alexkroman1/aai-cli/start` sits between the two. It
builds the server and binds nothing, so you decide how it is served.

Reach for it rather than `createAgentServer()` when what you want to own is the
listening, not the wiring: it loads the artifact `aai build` left, resolves
`.env`, picks up your built `client.tsx`, and creates the Postgres tables — the
whole of `npm start` except the last line. That is the shape a serverless host
needs, since it owns the socket and hands you a request, and
`aai build --target vercel` emits an entry that does exactly this. Use
`createAgentServer()` instead when you want to compose the agent in code, as
above.

## Durability is yours to provision

The platform gives an agent somewhere to keep things. Off it, you do, and it is
one variable.

With a `DATABASE_URL` in that `env`, session state and durable workflow runs go
to your Postgres. Without one they live in **this process's memory**, and a
restart forgets them. The boot line says which it picked, so this is never a
guess.

You do not have to migrate it. `createAgentServer()` creates the tables it owns
— two for session state, five for the run journal — before it binds, because the
tables come with whoever owns the database and a self-hosted deployment has no
migration step to hang them off.

That creation is best-effort by design. A role that may not `CREATE`, because
your own migration already made them, gets one warning and keeps serving.
`ensureSessionStateSchema` and `ensureWorkflowJournalSchema` are exported from
`@alexkroman1/aai-runtime` for exactly that operator, and running them yourself
is safe either way.

`PUBLIC_URL` is the other half, and it only matters if a workflow hands a URL to
somebody else. Behind a proxy that URL is not the socket the server binds, so it
is never sniffed.

:::note
Without `publicUrl`, `ctx.workflows.publicWebhookUrl(token)` throws and names
the option. That beats minting a `127.0.0.1` callback that fails days later on
someone else's server.
:::

## What doesn't come with you

`run_code` needs the platform's sandbox and refuses outside one.

Everything else — tools, state, workflows, telephony, your own UI — runs the
same code, against infrastructure you supply. The section above is the whole
list of what that means in practice.

## Next

- [CLI reference](/agent/cli/) — `aai build`, and the flags that feed this
- [Deploy anywhere](/agent/deploy/anywhere/) — when a generated target is enough
