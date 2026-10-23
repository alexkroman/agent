---
title: Run it locally
description: aai dev while you build, npm start when you want a plain Node process.
---

Two ways to run an agent on your own machine.

## `aai dev` — while you are building

```sh
aai dev
```

Starts a local server and prints a URL. Open it and click the microphone.

Edit `agent.ts`, a tool, or `system-prompt.md` and it rebuilds and replaces the
server.

## `npm start` — a plain Node process

```sh
npm start                          # http://127.0.0.1:3000
PORT=8080 HOST=0.0.0.0 npm start   # bind every interface, e.g. in a container
```

This is the deployment counterpart of `aai dev`: no platform account, nothing
managed. The scaffold's `prestart` script builds first
(`aai build --skip-tests`), then `aai start` serves the result.

`aai start` on its own never builds — it fails and tells you to run `aai build`.
It serves your `client.tsx` build when there is one, and falls back to the
default UI otherwise.

:::caution[It listens on `localhost` for a reason] This server has no request
authentication of its own, so set `HOST=0.0.0.0` only behind your own proxy or
auth. :::

There is no server file in your project. When you need to own the startup — your
own routes, your own auth — see [Self-hosting](/agent/more/self-hosting/).

## Using every core: `--workers`

One `aai start` process runs every call on a single thread, so it uses one CPU
core however many the machine has. `--workers` serves the same build from
several processes that share one port:

```sh
aai start --workers 4               # four processes
aai start --workers auto            # one per CPU core
AAI_WORKERS=auto npm start          # the same, for a container
```

Connections are dealt round-robin, so a browser that reconnects may reach a
different process than the one it started on. That only works when every process
shares the same state, so **more than one worker needs a `DATABASE_URL`**, and
`aai start` refuses to start without one. With it, a reconnect resumes the call
on whichever process it reaches, and durable runs and their `notify` work across
all of them. The tables are created once, before the workers start.

Two things still belong to one process: an `/api` route that speaks into a live
call (`ctx.speech`), and `/inbox` sockets. Each reaches only the calls held by
the process that took the request.

A worker that crashes is replaced, and only the calls it held are lost. A worker
that fails while starting — a port already in use, an unreachable database —
stops the whole server rather than restarting forever.

As a rough guide, one process holds on the order of a thousand concurrent
browser calls on a modern core before latency rises. Measure your own agent:
tools, long replies and big histories all cost more.

## Watching and restarts

Watching is on when you run `aai dev` at a terminal. `--watch=false` (or
`AAI_DEV_WATCH=0`) turns it off.

A restart ends any voice session in flight. That is right while you are editing
and wrong while something drives the agent for twenty minutes — so a harness or
process supervisor, which has no TTY, gets no watcher unless it sets
`AAI_DEV_WATCH=1`.

## What the dev server can see

Two things behave differently here than they do deployed.

**Secrets come from `.env` in the project root.** Only keys declared there are
visible to your tools as `ctx.env`. On the platform the same keys come from the
agent's secrets, which `aai publish` syncs from that same file.

**Session state lives in memory** for the life of the process, so a restart
forgets it; deployed, it is stored for you. Point a `DATABASE_URL` at your own
Postgres in `.env` and it becomes durable here too — same code either way. See
[Remembering things](/agent/build/state/).

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
