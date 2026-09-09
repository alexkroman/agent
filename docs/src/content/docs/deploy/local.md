---
title: Run it locally
description: aai dev while you build, npm start when you want a plain Node process.
---

Two ways to run an agent on your own machine: `aai dev` while you are building
it, and `npm start` when you want the plain Node process you would put in a
container.

## `aai dev`

```sh
aai dev
```

Starts a local server and prints a URL — open it and click the microphone.

### Watching and restarts

Watching is on when you run it at a terminal. An edit to `system-prompt.md`, a
tool, or `agent.ts` rebuilds and replaces the server. `--watch=false` (or
`AAI_DEV_WATCH=0`) turns it off.

A restart ends any voice session in flight. That is right while you are editing
and wrong while something drives the agent for twenty minutes — so a harness or
process supervisor, which has no TTY, gets no watcher unless it sets
`AAI_DEV_WATCH=1`.

### What the dev server can see

Two things behave differently here than they do deployed, and both are worth
knowing before you go looking for a bug that isn't one.

Secrets come from `.env` in the project root. Only keys declared there are
visible to your tools as `ctx.env` — on the platform the same keys come from the
agent's secrets, which `aai publish` syncs from that same file.

Session state lives in memory for the life of the process, so a restart forgets
it; deployed, it is stored for you. Point a `DATABASE_URL` at your own Postgres
in `.env` and it becomes durable here too — same code either way. See
[Remembering things](/agent/build/state/).

## `npm start`

`npm start` runs `aai start`, which serves the agent from a plain Node process —
no platform account, nothing managed. It is the deployment counterpart of
`aai dev`:

```sh
npm start                          # http://127.0.0.1:3000
PORT=8080 HOST=0.0.0.0 npm start   # bind every interface, e.g. in a container
```

The scaffold's `prestart` script builds first (`aai build --skip-tests`), then
`aai start` serves the result. `aai start` on its own never builds — it fails
and tells you to run `aai build`. It serves your `client.tsx` build when there
is one, and falls back to the default UI otherwise.

:::caution[It listens on `localhost` for a reason]
This server has no request authentication of its own, so set `HOST=0.0.0.0` only
behind your own proxy or auth.
:::

There is no server file in your project. When you need to own the startup — your
own routes, your own auth — see [Self-hosting](/agent/more/self-hosting/).

## Environment variables in a container

A real environment variable beats the file's value, so
`docker run -e MY_API_KEY=…` needs no `.env` in the image.

That works only for keys something declares, and `.env.example` counts as a
declaration and ships. A variable nothing declares never reaches `ctx.env`.

For Vercel, Deno Deploy, or Modal rather than a container, see
[Deploy anywhere](/agent/deploy/anywhere/).

## Next

- [Publish](/agent/deploy/publish/) — the managed platform, in two commands
- [Deploy anywhere](/agent/deploy/anywhere/) — Vercel, Deno Deploy, Modal
- [Self-hosting](/agent/more/self-hosting/) — owning the startup yourself
