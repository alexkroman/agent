---
title: Run it locally
description: aai dev while you build, npm start when you want a plain Node process.
---

## `aai dev`

```sh
aai dev --watch
```

Starts a local server and prints a URL — open it and click the microphone.

Watching is opt-in: with `--watch` (or `AAI_DEV_WATCH=1`) an edit to
`system-prompt.md`, a tool, or `agent.ts` rebuilds and replaces the server.
Without it, restart to pick up a change. A restart ends any voice session in
flight, which is why it is not the default.

Secrets come from `.env` in the project root. Only keys declared there are
visible to your tools as `ctx.env`.

Session state lives in memory for the life of the process. Point a
`DATABASE_URL` at your own Postgres in `.env` and it becomes durable —
same code either way. See [Remembering things](/agent/build/state/).

## `npm start`

`npm start` runs `aai start`, which serves the agent from a plain Node
process — no platform account, nothing managed. It is the deployment
counterpart of `aai dev`:

```sh
npm start                          # http://127.0.0.1:3000
PORT=8080 HOST=0.0.0.0 npm start   # bind every interface, e.g. in a container
```

The scaffold's `prestart` script builds first (`aai build --skip-tests`),
then `aai start` serves the result. `aai start` on its own never builds — it
fails and tells you to run `aai build`. It serves your `client.tsx` build when
there is one and falls back to the default UI otherwise.

Two things to know:

- **It only listens on `localhost` by default.** This server has no request
  authentication of its own, so set `HOST=0.0.0.0` only behind your own proxy
  or auth.
- **There is no server file in your project.** When you need to own the
  startup — your own routes, your own auth — see
  [Self-hosting](/agent/more/self-hosting/).

A real environment variable beats the file's value, so
`docker run -e MY_API_KEY=…` needs no `.env` in the image — but only for keys
something declares. `.env.example` counts as a declaration and ships, which is
what makes the container case work; a variable nothing declares never reaches
`ctx.env`.

For Vercel, Deno Deploy, or Modal rather than a container, see
[Deploy anywhere](/agent/deploy/anywhere/).
