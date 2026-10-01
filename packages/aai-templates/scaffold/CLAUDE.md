# AssemblyAI Agent SDK

You are helping build a voice agent with the **AssemblyAI Agent SDK**. This is
the CORE guide: read all of it first. It covers the loop, the project layout,
`agent()` and `tool()` basics, the prompt, secrets and the gotchas. Everything
else is a topic file beside it — read one when the task needs it.

## Read X when Y

The topic files sit in `agent-guide/` next to this file (in an installed
project: `node_modules/@alexkroman1/aai/agent-guide/`).

| Read                             | When the task involves                                                     |
| -------------------------------- | -------------------------------------------------------------------------- |
| `agent-guide/AGENT-API.md`       | any `agent()` field not shown below (guardrails, MCP, routes, lifecycle)   |
| `agent-guide/TOOLS.md`           | a tool body: `ctx`, `sessionSlot`, `dialog()`, speakers, `clientTool()`    |
| `agent-guide/WORKFLOWS.md`       | work that outlives the call: `workflow()`, `workflowApp()`, steps, uploads |
| `agent-guide/PIPELINE-TUNING.md` | pipeline vs S2S vs text, turn-taking knobs, phone calls, `ctx.speech`      |
| `agent-guide/PROVIDERS.md`       | an STT, LLM or TTS vendor or model; the voice catalog                      |
| `agent-guide/UI.md`              | `client.tsx`: `mountClient()`, hooks, components, styling                  |
| `agent-guide/TESTING-EVALS.md`   | `agent.test.ts`, `runTool`, `agent.eval.test.ts`                           |
| `agent-guide/HOSTING.md`         | `npm start`, OpenTelemetry tracing, `aai build --target`                   |

## Workflow

The fast loop: edit → `pnpm dev` (browser, talk to it) → `pnpm test` (logic) →
`pnpm build` (validate bundle).

1. **Iterate in `pnpm dev`** — browser UI; it restarts on every save at a
   terminal (`AAI_DEV_WATCH=0`/`1` forces it off/on). Speak to the agent to
   verify behavior end-to-end. This is the primary feedback loop.
2. **Run `pnpm test` after logic changes** — vitest, co-located as
   `agent.test.ts`. **When the project has one, it is yours to maintain**: a
   test asserting the old agent's shape is stale after a rewrite, and updating
   it is a normal fix. Do not delete a test to make it pass.
   `agent-guide/TESTING-EVALS.md` has `virtual:aai/agent` and `runTool`.
3. **Run `pnpm eval` when you change what the agent DOES** — a test asserts the
   shape; an eval (`agent.eval.test.ts`, harness imported from
   `@alexkroman1/aai-runtime/testing/vitest`) drives a real session and asserts
   what it did. With a provider key it uses a LIVE model (spends tokens, noisy);
   without one a SCRIPTED model, which proves wiring and nothing about what the
   agent says.
4. **Run `pnpm build` before declaring done** — bundles `agent.ts`,
   type-checks, validates the manifest, and runs the WHOLE spec suite first.
   Catches issues `dev` won't.
5. **Make small, focused changes** — verify each one before stacking the next.
6. **Look at templates before writing custom code** — the CLI ships working
   examples inside its own package, at
   `node_modules/@alexkroman1/aai-cli/dist/templates/`. Read them directly;
   `aai init --template <name>` scaffolds a fresh project from one. Closest:
   `quickstart-agent`, `custom-pipeline-agent`, `web-research-agent`,
   `pizza-ordering-agent`, `retail-orders-agent` (the most complex). Built
   entry points under `node_modules/@alexkroman1/aai*/dist/` re-export with
   source specifiers — rewrite `.ts`/`.tsx` to `.d.ts` to find the file.

## CLI

The scaffold's `package.json` runs the project's own CLI as `pnpm dev`,
`build`, `test`, `eval`, `start` and `publish:agent`; anywhere else it is
`npx aai <command>` (or `npm i -g @alexkroman1/aai-cli` once).

```sh
aai init [dir]           # Scaffold a new agent (--template <name>)
aai templates            # List available templates
aai dev                  # Start the local dev server
aai dev --tunnel         # ...on a public URL (sets PUBLIC_URL)
aai console              # Talk to the agent through your mic and speakers
aai test                 # Run the project's specs via vitest
aai test --only          # ...or agent.test.ts alone
aai eval                 # Run agent.eval.test.ts against a model
aai build                # Bundle and validate (--target node|vercel|deno)
aai start                # Serve the built agent yourself (production)
aai login                # Link your account and save your API key
aai list                 # List your studio projects
aai pull <project> [dir] # Pull a studio project into a directory
aai push                 # Sync this project's source to its studio workspace
aai publish              # Push to the studio AND deploy to production
aai delete               # Delete the studio project and its deployed agents
aai logs [-f]            # Show what the deployed agent has printed
aai secret put NAME      # Set a secret (value from stdin or a masked prompt)
aai secret put --local NAME  # ...in .env
aai secret delete NAME
aai secret list
aai workflow list        # The workflows this agent declares
aai workflow runs <name> # Recent runs of one, newest first
aai workflow show <id>   # One run, including its output
aai workflow cancel <id> # Stop a running run
```

**A bare `aai` in an agent directory PUBLISHES** (it asks first at a terminal).
**`aai test` runs every non-eval spec**, which `--only` narrows to
`agent.test.ts`; a narrowed run names the files it skipped and answers
`complete: false`. `pnpm test` is `aai test`, and so is the gate in front of
`aai build`.

## Project structure

```text
my-agent/
  agent.ts            # Agent definition (required)
  agent.test.ts       # Unit tests (optional)
  agent.eval.test.ts  # Behaviour evals, run by `pnpm eval` (optional)
  client.tsx          # Custom UI (optional, React)
  shared.ts           # Types shared between agent.ts and client.tsx
  system-prompt.md    # The system prompt — discovered, not imported
  tools/              # One file per tool — this is how a tool is declared
  workflows/          # Durable workflow bodies (optional — see agent-guide/WORKFLOWS.md)
  package.json
  tsconfig.json
  .env                # Local dev secrets (gitignored)
```

`client.tsx` needs no `vite.config.ts` (React + Tailwind by default).

### A file in `tools/` IS a tool — there is no registration step

**`tools/` is not a convention, it is the mechanism.** A file there is named for
the tool the model calls, default-exports it, and is picked up by the build. It
is not imported by `agent.ts` and not listed anywhere — `agent()` has no
`tools` field at all:

```ts
// tools/roll_dice.ts  →  the model calls this "roll_dice"
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Roll dice",
  inputSchema: z.object({ sides: z.number() }),
  execute({ sides }) {
    return Math.floor(Math.random() * sides) + 1;
  },
});
```

Three rules come with it, each a build error naming the file:

- **The file name is the tool name**, so it must be lowercase, start with a
  letter, and join words with `_` — `tools/incident_create.ts`, never
  `incident-create.ts`. Renaming the file renames the tool.
- **The export is the DEFAULT export**, and it must be a `tool()` (or a
  `slot.tool()` / `slot.updateTool()`). A file exporting something else is
  named at build time rather than becoming a tool that fails per turn.
- **`tools/` is flat.** A nested file — a nested HELPER too — is rejected, so
  put shared helpers beside `agent.ts` rather than under `tools/`.

## `agent()` basics

The minimal agent — a cascaded pipeline, what to build unless the user asks
for speech-to-speech:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
});
```

No provider fields means the default all-AssemblyAI pipeline (STT → LLM → TTS)
on the one key a published agent is guaranteed to have. Swap one stage by
declaring just that field — a voice is the TTS descriptor's, and `llm` takes a
model id:

```ts
import { agent } from "@alexkroman1/aai";
import { assemblyAITts } from "@alexkroman1/aai/tts";

export default agent({
  name: "My Agent",
  tts: assemblyAITts({ voice: "paul" }),
  llm: "claude-sonnet-4-6",
  greeting: "Hi, how can I help?",
  builtinTools: ["think", "web_search"],
  maxSteps: 6,
  requiredEnv: ["WEATHER_KEY"],
});
```

The fields almost every agent sets: `name` (required), `greeting` (default:
"Hey there..."; `""` starts silent), `tts` (voice `jane` unless set), `llm`,
`builtinTools` (omitted = `["think"]` only; setting it REPLACES the default),
`maxSteps` (default 10 tool-calling steps per reply) and `requiredEnv` (every
env var a tool or step reads; **publishing checks it**, so a missing key fails
at `aai publish` instead of mid-call). `agent-guide/AGENT-API.md` lists every
field.

**Four modes, one field: `mode`.** Omit it for PIPELINE — the default, and the
mode this guide assumes. `mode: "s2s"` beside an `s2s: assemblyAIS2s()`
descriptor selects speech-to-speech; `mode: "text"` a text-only agent;
`workflowApp()` (`mode: "workflow-app"`) a form with no session at all
(`agent-guide/WORKFLOWS.md`). A field the chosen mode does not have is a
compile error naming the mode. `assemblyAIPipeline()` is the explicit spelling
of the default pipeline (spread it for `region: "eu"`). Pipeline knobs and S2S
are in `agent-guide/PIPELINE-TUNING.md`; vendors in `agent-guide/PROVIDERS.md`.

## `tool()` basics

```ts
// tools/get_weather.ts  →  the model calls this "get_weather"
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Get current weather for a city", // shown to the model — decides when to call
  inputSchema: z.object({
    city: z.string().describe("City name"),
  }),
  async execute({ city }, ctx) {
    const resp = await fetch(
      `https://api.example.com/weather?q=${city}&key=${ctx.env.WEATHER_KEY}`,
      { signal: ctx.signal },
    );
    return resp.json();
  },
});
```

- **`execute` must return a value** (sync or async); it goes to the model.
  `fetch` works directly, identically in `aai dev` and deployed.
- **`inputSchema` is a `z.object(...)` or absent.** Make a FIELD optional,
  never the object; omit the schema for a no-argument tool.
- **Do not annotate `execute`'s return type** — it breaks the moment the tool
  also returns an error shape. Let it infer.
- **`ctx`** carries `env` (secrets; every read is `string | undefined` —
  `requireEnv(ctx, "KEY")` fails by name), `signal` (pass it to anything slow),
  `messages`, `sessionId`, `send(event, data)` to the browser,
  `generate(...)` for a one-shot model call, `delegate(...)` for a speaker,
  `speech` to say something later and `workflows` to start a durable run.
- **State across tool calls lives in a `sessionSlot`** — `slot.tool` reads,
  `slot.updateTool` writes. Never keep it in a module variable: every session
  shares the module.

`agent-guide/TOOLS.md` has the rest: `ctx` in full, session state, `dialog()`
and `procedure()`, speakers and the roster, `clientTool()` (a tool the
browser runs), the built-in tool table, `/utils`,
`/html`, persistence and the speech helpers.

## `system-prompt.md` IS the system prompt

**Write the prompt in `system-prompt.md` beside `agent.ts`, and declare
nothing.** The build discovers the file, so there is no import line and no
field — the same rule `tools/` follows, applied to the one part of an agent
that is a DOCUMENT rather than a value.

```markdown
<!-- system-prompt.md -->

You are a concise, friendly assistant.

- Keep replies to one or two sentences.
- Never read a URL aloud.
```

**Your prompt is ADDED to the framework's voice sections, never a
replacement** — yours comes last and wins on conflict. Never interpolate
`DEFAULT_SYSTEM_PROMPT` (exported to be READ).

Three rules, each a build error naming the file:

- **A file nothing reads is an error.** If `system-prompt.md` exists and
  `agent.ts` declares a DIFFERENT `systemPrompt`, the build fails rather than
  ignoring the file.
- **An empty file is an error**, not a silent fall-through to the framework
  default. Delete the file if that is what you want.
- **A `system-prompt/` directory is rejected.** One file, no concatenation
  order to guess.

Composing a prompt from the file plus computed text, and a per-request prompt
resolver, are in `agent-guide/AGENT-API.md`. `greeting` stays a field: a
document goes in a file, a value stays in the call.

## Voice rules for systemPrompt

**Don't restate the voice rules — the framework always emits them.** Write only
what the defaults cannot say: "use run_code for ANY math", "you ARE the game".
Opt-in presets (`voicePresets`) are in `agent-guide/AGENT-API.md`.

## Secrets

Never hardcode secrets in agent code.

- **Local dev:** `.env` in project root. Only declared keys are available via
  `ctx.env`.
- **Production:** `aai secret put NAME`, and list the name in `requiredEnv`.
- **Access:** `ctx.env.MY_KEY` in a tool; `stepEnv("MY_KEY")` in a step.
- **AssemblyAI key:** `aai login` links your account and stores the key
  globally — the only way the CLI authenticates. No `.env` entry needed. For
  CI, point `AAI_CONFIG_DIR` at a config dir holding a logged-in key (an
  exported `ASSEMBLYAI_API_KEY` does not authenticate).

## Subpath exports

Most of the API is not on the root entry. Import each name from the subpath
that owns it:

<!-- BEGIN GENERATED aai subpaths: pnpm sync:agent-guide -->

- `@alexkroman1/aai` — declaring the agent: `agent`, `tool`, `clientTool`,
  `sessionSlot`, `dialog`, `procedure`, `workflow`, `workflowApp`, `speaker`,
  `roster`, the speech helpers, and their types
- `@alexkroman1/aai/utils` — zero-dependency helpers for a tool body, a step or
  a client — `isToolFailure`, `createKeyedLock`, `pushCapped`, `errorMessage`,
  `omitUndefined`
- `@alexkroman1/aai/step` — step code in `workflows/*.ts` — `stepEnv`,
  `stepFetch`, `stepGenerate`, transcription, `stepSpeak`, uploads,
  `mapConcurrent`, `stepPlaceCall`
- `@alexkroman1/aai/testing` — where the spec helpers (`runTool`,
  `createToolContext`, `deployedAgent`, the step stubs) are declared — a test
  file imports them through `@alexkroman1/aai-runtime/testing`
- `@alexkroman1/aai/testing/vitest` — where the installers are declared — a test
  file imports them through `@alexkroman1/aai-runtime/testing/vitest`
- `@alexkroman1/aai/testing/vite` — the plugin `vitest.config.ts` registers to
  serve `virtual:aai/agent`
- `@alexkroman1/aai/channels` — posting a run's result to Slack or SMS
- `@alexkroman1/aai/step-errors` — `orFail` around a step call, and
  `FatalError`/`RetryableError` classification
- `@alexkroman1/aai/workflow-api` — a page, script or cron job calling a
  deployed agent's workflow API
- `@alexkroman1/aai/stt` — an STT provider for a pipeline stage
  (`assemblyAIStt`, `deepgramStt`, …)
- `@alexkroman1/aai/tts` — a TTS provider for a pipeline stage (`assemblyAITts`,
  `cartesiaTts`, `rimeTts`)
- `@alexkroman1/aai/llm` — an LLM provider for a pipeline stage
  (`llm({ provider, model })`)
- `@alexkroman1/aai/s2s` — a speech-to-speech provider (`assemblyAIS2s`,
  `openAIS2s`)
- `@alexkroman1/aai/ffmpeg` — running ffmpeg or probing media from a step
- `@alexkroman1/aai/html` — reading a fetched page or RSS/Atom feed (Node-only)
- `@alexkroman1/aai/step-files` — streaming an upload too big for memory to disk
  inside a step
- `@alexkroman1/aai/tools` — calling `webSearch`, `visitWebpage` or `fetchJson`
  from your own tool code
- `@alexkroman1/aai/experimental` — unstable integrations (Composio,
  deep-research helpers) — may change in any release
- `@alexkroman1/aai/tsconfig` — the tsconfig preset a project's `tsconfig.json`
  extends

Framework-internal, never imported by an `agent.ts`: `/protocol`,
`/coding-tools`, `/workspace-files`, `/slugify`, `/manifest`, `/internal`,
`/host-internal`.

<!-- END GENERATED aai subpaths -->

`@alexkroman1/aai-ui` is the browser client (`agent-guide/UI.md`) and
`@alexkroman1/aai-runtime` the host runtime. **A test file imports testing
names from its two doors only**: `@alexkroman1/aai-runtime/testing` (every
fake and reader, plus `runWorkflow`) and `/testing/vitest` (every `install*`,
plus the eval suites) — `agent-guide/TESTING-EVALS.md`.

## Gotchas

- **Tool execute must return a value.** A missing return = `undefined` in LLM
  context = the model thinks the tool failed.
- **`verbatimModuleSyntax` is on**: `import type { ToolContext }`, or
  `import { agent, type ToolContext }`.
- **There is no global `JSX` namespace** (React 19): type a component's return
  as `ReactNode`.
- **Always import `"@alexkroman1/aai-ui/styles.css"` first** in `client.tsx`,
  and don't create `tailwind.config.js` — Tailwind v4 is configured via CSS.
- **Derive client state with `useAgentState`/`useToolResult`, not `useEffect` +
  `toolCalls`** — the effect re-fires every render and duplicates.
- **Never await `ctx.speech.say(...).done` inside a tool's `execute`** — the
  line waits behind the reply that tool is part of.
- **Never call `Math.random()` in a tool** — use `ctx.random`, which a spec can
  substitute. A workflow body uses its journaled `ctx.random()`.
- **The LLM loop runs one step's tool calls CONCURRENTLY**: serialize a
  read-modify-write over anything outside a slot with `createKeyedLock`
  (`/utils`).
- **The network builtins refuse private IPs** (SSRF). Use public URLs.
- **`run_code` refuses under `aai dev`/`aai start`** unless the shell sets
  `AAI_RUN_CODE=deno`: each call then runs in its own Deno 2 with no network,
  file or env access. Deployed, it runs in the platform's sandbox. Or use the
  `calculate` builtin for simple arithmetic.
- **There is no `ctx.db`.** A tool that persists brings its own client — see
  "Persisting data" in `agent-guide/TOOLS.md`. A secret is read when the
  sandbox is BUILT, so a newly set `DATABASE_URL` arrives on the next deploy.
- **A wrong TTS voice id is silent**: it is refused after the socket opens.
  Pick from the catalog in `agent-guide/PROVIDERS.md`. **Rime language codes
  are ISO 639-3** (`"eng"`), not ISO 639-1 (`"en"`).

## Constraints

- Tool `execute` return values go into LLM context, capped at 4000 chars
  (a truncation marker replaces the tail) — filter large API responses
- Agent code runs in a sandboxed worker with open egress for your own `fetch`
- Tool execution timeout: 30 seconds
- `maxSteps` caps tool calls per turn (default 10) — lower it for latency. At
  the cap one more step runs with tools off, so the agent answers with what it
  has instead of going silent mid-chain
