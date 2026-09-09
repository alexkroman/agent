---
title: Run it locally
description: aai dev while you build, npm start when you want a plain Node process.
---

## `aai dev`

```sh
aai dev
```

Starts a local server and opens a browser voice client. It rebuilds on save,
so editing `system-prompt.md`, a tool, or `agent.ts` takes effect without a
restart.

Secrets come from `.env` in the project root. Only keys declared there are
visible to your tools as `ctx.env`.

Session state lives in memory for the life of the process. Point a
`DATABASE_URL` at your own Postgres in `.env` and it becomes durable —
same code either way. See [Remembering things](/agent/build/state/).

## `npm start`

`aai start` serves the agent from a plain Node process — no platform account,
nothing managed. It is the deployment counterpart of `aai dev`:

```sh
npm start                          # http://127.0.0.1:3000
PORT=8080 HOST=0.0.0.0 npm start   # bind every interface, e.g. in a container
```

`npm start` builds first and then serves the result — the same artifact
`aai publish` uploads. It serves your `client.tsx` build when there is one and
falls back to the default UI otherwise.

Two things to know:

- **It binds loopback by default.** This server has no request authentication
  of its own, so set `HOST=0.0.0.0` only behind your own proxy or auth.
- **There is no server file in your project**, deliberately — the boot belongs
  to the framework, so it improves when you update rather than freezing at the
  moment you scaffolded. When you need to own it, see
  [Self-hosting](/agent/more/self-hosting/).

A real environment variable beats `.env`, so `docker run -e MY_API_KEY=…`
needs no `.env` in the image.

For Vercel, Deno Deploy, or Modal rather than a container, see
[Deploy anywhere](/agent/deploy/anywhere/).
