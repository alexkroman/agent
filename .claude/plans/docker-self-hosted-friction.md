# Plan: Docker Self-Hosted Deployment Friction

**Status:** in-progress
**Created:** 2026-03-26
**Updated:** 2026-03-26

## Context

Simulated the experience of an AI agent (or new developer) trying to create a
voice AI app and deploy it in Docker using the self-hosted `createServer()`
path. No KV or vector store usage — just a simple weather agent with a custom
tool.

## Goals

- [x] Create a working voice AI agent with a custom tool
- [x] Create a Dockerfile for self-hosted deployment
- [x] Document friction points encountered during the process
- [ ] Address friction points in SDK/docs

## Friction Points

### 1. No self-hosted Docker example or guide

**Severity:** High
**Impact:** Users have no reference for containerizing a self-hosted agent.

The existing `Dockerfile` in the repo root is for the **platform server**
(`aai-server`), not for a user self-hosting their own agent. There is no
example, template, or documentation showing how to Dockerize a
`createServer()` app.

A user has to reverse-engineer the pattern from the platform Dockerfile and
the `createServer()` API docs. This is the single biggest friction point.

**Suggested fix:** Add an `examples/docker-self-hosted/` directory (done in
this PR) and reference it from the self-hosting section of the CLAUDE.md
template.

### 2. Peer dependencies are not obvious for self-hosting

**Severity:** Medium
**Impact:** Users get confusing errors or silent failures.

`createServer()` requires `hono` and `@hono/node-server` as peer
dependencies, but these are marked optional in the SDK's `package.json`.
A user who runs `npm install @alexkroman1/aai` and then tries to import
`@alexkroman1/aai/server` will get a module-not-found error for hono at
runtime with no helpful message.

The CLAUDE.md template mentions `createServer()` but doesn't explicitly
list the required peer deps for self-hosting. A user following the docs
has to discover by trial and error that they need:

```
npm install @alexkroman1/aai hono @hono/node-server zod
```

**Suggested fix:**
- Add a "Self-hosting prerequisites" callout in the CLAUDE.md template
  listing the required peer deps.
- Consider making `createServer()` throw a clear error message if hono
  is not installed, rather than letting Node's module resolver produce a
  cryptic error.

### 3. `ASSEMBLYAI_API_KEY` is easy to forget

**Severity:** Medium
**Impact:** Server starts but WebSocket sessions fail silently.

The server boots successfully without `ASSEMBLYAI_API_KEY` set. The only
signal is a warning about missing `authToken`. When a client connects and
tries to speak, the S2S connection to AssemblyAI fails — but there's no
clear startup error telling you "you forgot to set ASSEMBLYAI_API_KEY."

**Suggested fix:** Log a clear warning at startup if `ASSEMBLYAI_API_KEY`
is not in the env. Or add a `--check` flag that validates required config
before starting.

### 4. No `docker-compose.yml` example

**Severity:** Low
**Impact:** Users have to figure out env var passing and port mapping.

Docker Compose is the standard way to run containers locally with env files.
A simple `docker-compose.yml` example would save time:

```yaml
services:
  agent:
    build: .
    ports:
      - "3000:3000"
    env_file:
      - .env
```

### 5. No client HTML for self-hosted mode

**Severity:** Low
**Impact:** Users get a bare "Agent server running" page with no UI.

When using `createServer()` without `clientDir` or `clientHtml`, visiting
the server in a browser shows a plain `<h1>` tag. There's no built-in way
to serve the default `aai-ui` component without either:
- Bundling a client separately and passing `clientDir`
- Inlining HTML via `clientHtml`

For a Docker deployment, bundling a client adds significant complexity
(Vite/esbuild, Preact, Tailwind). Users who just want to test their agent
in a browser have no simple path.

**Suggested fix:** Consider shipping a prebuilt default client HTML that
`createServer()` can serve when no `clientDir`/`clientHtml` is provided,
or add a CLI command like `aai build --self-hosted` that produces a
`public/` directory ready to serve.

### 6. No guidance on production Docker best practices

**Severity:** Low
**Impact:** Users deploy insecure or oversized containers.

The docs don't mention:
- Using multi-stage builds to reduce image size
- Setting `NODE_ENV=production`
- Running as a non-root user
- Health check configuration
- Graceful shutdown handling (the server already supports `close()` but
  there's no `SIGTERM` handler in the example)

## Tasks

- [x] Create example agent (`agent.ts`)
- [x] Create server entry point (`server.ts`)
- [x] Create Dockerfile
- [x] Create `.env.example`
- [x] Create `package.json` for the example
- [x] Document friction in this plan
- [x] Add SIGTERM handler to server.ts
- [x] Add docker-compose.yml

## Open Questions

- Should the example live in `examples/` in the repo, or should it be a
  template available via `aai init -t docker`?
- Should `createServer()` ship a minimal default UI so users can test
  without bundling a client?
- Should we add a startup validation that checks for `ASSEMBLYAI_API_KEY`?

## Notes

The Docker build couldn't be verified end-to-end in this session (no
outbound network to pull base images), but the Dockerfile syntax is valid
and the app starts correctly with `node server.ts`.
