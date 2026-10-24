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
several processes behind one port:

```sh
aai start --workers 4               # four processes
aai start --workers auto            # one per CPU core
AAI_WORKERS=auto npm start          # the same, for a container
```

Every request from one browser reaches the same worker. The browser's client id
(sent by the default UI on every connection) decides which, so a call, its
`/inbox` socket and its `/api` requests always land together. A reconnect
resumes on the worker that holds the call, so **no database is needed** for
voice. Audio goes straight to its worker; the process in front only routes.

A `DATABASE_URL` adds two things memory cannot:

- **A call survives its worker crashing.** A crashed worker is replaced, and a
  reconnect resumes from Postgres. Without one, a crash loses that worker's
  calls.
- **Workflows.** A run must be readable from every worker, so an agent that
  declares workflows refuses to start on more than one worker without a
  `DATABASE_URL`. With one, a step that notifies a client's `/inbox` reaches it
  whichever worker runs the step.

The tables are created safely when several processes start at once.

An `/api` request that speaks into a live call (`ctx.speech`) reaches it only
when the request carries the caller's `?client=`. The default UI's route hooks
send it; a webhook from another service, which knows only a session id, should
look the call up some other way.

### Restarts without dropping calls

The process in front owns every worker's lifecycle:

- **`SIGTERM` (or Ctrl-C) drains.** New calls are refused with `503`, while
  reconnects, `/api` requests and run reads keep working. Each worker exits once
  its calls end, or after `--drain-timeout` seconds (default 300, or
  `AAI_DRAIN_TIMEOUT`). A second signal stops at once. Give your platform's
  shutdown grace period at least the drain timeout, or it will kill the calls
  first.
- **`SIGHUP` is a rolling restart.** Each worker is replaced in turn: a fresh
  one starts, takes that worker's new calls, and the old one finishes its calls
  before exiting. Live calls are not interrupted. A call that reconnects
  mid-rollover resumes only with a `DATABASE_URL`.
- **`--max-calls-per-worker <n>`** (or `AAI_MAX_CALLS_PER_WORKER`) refuses new
  calls with `503` once a worker holds that many. Load is refreshed every couple
  of seconds, so the limit can briefly lag a hang-up.

`curl localhost:3000/workers`, from the machine itself, shows each worker's
state, live calls and event-loop load.

A worker that fails while starting (an unreachable database, say) stops the
whole server rather than restarting forever. A worker that stops responding for
15 seconds is restarted, and one that is slow to respond is reported first.

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
