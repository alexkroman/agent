<!--
  GENERATED FILE — do not edit.

  Source: packages/aai-templates/scaffold/agent-guide/HOSTING.md
  Regenerate: node scripts/sync-agent-guide.mjs

  This copy ships inside the @alexkroman1/aai tarball so an agent working in
  a user's project reads guidance that MATCHES the installed SDK. It is the
  only copy such a project has: `aai init` writes a short pointer at
  AGENT_GUIDE.md as the project's CLAUDE.md rather than a snapshot that goes
  stale on the next `pnpm update`. See packages/aai/skills/aai/SKILL.md.
-->
# Self-hosting, tracing and deploy targets

Part of the aai authoring guide (start with the core guide). The managed
platform is `aai publish`; this file is everything that runs the agent
somewhere else — `npm start`, OpenTelemetry tracing, and `aai build --target`.

## Running it yourself (`npm start`)

`aai start` serves this agent from a plain Node process — no platform account,
nothing managed. It is the deployment counterpart of `aai dev`:

```sh
npm start                          # http://127.0.0.1:3000
PORT=8080 HOST=0.0.0.0 npm start   # bind every interface, e.g. in a container
```

`npm start` **builds first** (that is the `prestart` script) and then serves
the result: `aai start` boots `.aai/worker.mjs`, the same artifact
`aai publish` uploads. It serves your own `client.tsx` build when there is one
and falls back to the prebuilt default UI shipped inside `@alexkroman1/aai-ui`.

There is no server file in your project, and that is deliberate — the boot
belongs to the framework, so it improves when you update rather than being
frozen at the moment you scaffolded. When you need to own it, import
`createProjectServer` from `@alexkroman1/aai-cli/start`: it builds the server
and binds nothing, so you decide how it is served. Building one from scratch
instead, `defaultClientDir()` (`@alexkroman1/aai-ui/client-dir`) is where that
prebuilt UI lives — the only export of `aai-ui` that runs on Node rather than
in the browser.

The build is what makes `tools/` work — a tool is registered by existing, and
the enumeration happens where the bundle is assembled, so a server that loaded
`agent.ts` directly would run an agent with none of its tools. The same build
produces your `client.tsx`, so a custom UI is served with no extra step.

Secrets work the same as everywhere else: `ctx.env` holds the keys declared
in `.env` (or `.env.example`), and a real environment variable of that name
wins — so `docker run -e MY_API_KEY=…` needs no `.env` in the image.

One thing to know: it binds **loopback by default**, because this server has
no request authentication of its own; set `HOST=0.0.0.0` only behind your own
proxy or auth.

`run_code` is the one feature that does not follow — it needs a sandbox
(the platform's, or `AAI_RUN_CODE=deno`) and refuses outside one.

## Tracing (OpenTelemetry)

Point the runtime at any OTLP collector and it exports spans for the model
calls your agent makes — one per generation, with a child per step, per model
call and per tool call, carrying model id, token counts and finish reason.

**It is off unless you configure a collector, and that is the whole switch:**

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm start
OTEL_SERVICE_NAME=my-agent npm start          # names the spans; defaults to "aai-agent"
OTEL_EXPORTER_OTLP_HEADERS="x-api-key=…" npm start   # if your collector wants one
```

With none of those set, nothing is built — no exporter, no provider, no timer,
no import. That matters on a voice agent: a background flush is a timer on a
process whose latency budget is a person waiting for an answer.

**Install the exporter first.** The OpenTelemetry packages are optional peers,
so they are not in your `node_modules` until you ask for them:

```sh
npm i @opentelemetry/api @opentelemetry/sdk-trace-base \
      @opentelemetry/exporter-trace-otlp-proto @opentelemetry/resources \
      @opentelemetry/context-async-hooks
```

`aai dev` and `aai start` arm it for you. Embedding the server in a process of
your own means calling it yourself, from
`@alexkroman1/aai-runtime/tracing`:

```ts
import { startTracing, tracingEndpoint } from "@alexkroman1/aai-runtime/tracing";

// Returns undefined when no collector is configured. `RuntimeTracing` is the
// handle: `forceFlush()` before a scheduled shutdown, `shutdown()` to release.
const tracing = await startTracing();
if (tracingEndpoint()) console.log("exporting spans");
process.on("SIGTERM", () => void tracing?.shutdown());
```

`startTracingDetached()` is the same thing without the await, for a boot path
that must not wait — constructing the exporter costs a few hundred ms.
`OTEL_ENDPOINT_ENVS` and `OTEL_SERVICE_NAME_ENV` name the variables read, and
`DEFAULT_SERVICE_NAME` the fallback, if you would rather read them than
hard-code the strings.

**Spans carry no conversation content.** Not a default you can change — there
is no code path that reads a prompt, a completion, a transcript, a tool
argument or a tool result, so none of it can reach your collector. Attributes
are built from an allow-list of metadata names following OpenTelemetry's
`gen_ai.*` conventions, so existing dashboards find them.

### Deploying to a host that wants its own entry file

`aai build --target <host>` writes the deployment that host expects into the
build output. Nothing host-specific lives in your project: the files are
generated, gitignored, and rewritten by the host's own build.

```sh
aai build --target vercel   # writes .vercel/output/ (Build Output API v3)
aai build --target deno     # writes .aai/deno/ — `cd` there and `deno deploy`
```

On Vercel you rarely type it: the target is detected from that host's own build
environment, so a git push picks it up with nothing configured. Deno is the
other shape — `deno deploy` uploads a directory built on YOUR machine, so you
pass the flag and then deploy what it wrote:

```sh
aai build --target deno
cd .aai/deno && deno deploy --entrypoint server.mjs
```

That directory is self-contained on purpose. It holds the bundled server, the
built worker, your client and `.env.example`, and it needs no install step —
which is also why it is a directory rather than files in your project root:
`deno deploy` uploads the working directory, so emitting in place would ship
your `node_modules` and your `.env` along with it. Set secrets with
`deno deploy env add --secret ASSEMBLYAI_API_KEY <key>`; `.env` is deliberately
not copied.

`--target node`, the default everywhere else, emits nothing extra and is what
`npm start` runs.

One thing to know before deploying a VOICE agent to a serverless host: the
session is a WebSocket, so the host has to support one. Vercel does — it hands
the function the raw upgrade, and the emitted entry passes it to the same
server `aai dev` runs. Deno Deploy does too, and more simply: it runs a
long-lived process, so the emitted entry just calls `listen()` and the session
reaches the same server unchanged. A host that serves only request/response
still runs the HTTP surface — `/health`, `/client-config`,
`/workflows/*` and your static assets — which is everything a workflow app
needs and none of what a voice agent needs.
