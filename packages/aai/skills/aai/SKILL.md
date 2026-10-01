---
name: aai
description: Build voice agents with the AssemblyAI Agent SDK. Use when creating, editing, or debugging an agent — agent.ts, tools, session state, STT/TTS/LLM/S2S providers, the browser client, or the `aai` CLI.
---

# AssemblyAI Agent SDK

The AssemblyAI Agent SDK is a voice-agent development kit. An agent is a
directory containing `agent.ts`; the `aai` CLI bundles it and deploys it to the
managed platform, or `npm start` (`aai build` then `aai start`) runs it
standalone.

## Source of truth

**The guide ships inside the installed package. Read it — do not work from
this file.**

```text
node_modules/@alexkroman1/aai/AGENT_GUIDE.md
```

Start there: it is the CORE guide (the workflow loop, `agent()` and `tool()`
basics, the `tools/` directory rule, `system-prompt.md`, secrets and the
gotchas), and it opens with a "Read X when Y" routing table. Read the core
whole, then open only the topic files the task needs — they sit beside it in
`node_modules/@alexkroman1/aai/agent-guide/` (`TOOLS.md`, `WORKFLOWS.md`,
`PIPELINE-TUNING.md`, `PROVIDERS.md`, `UI.md`, `TESTING-EVALS.md`,
`HOSTING.md`, `AGENT-API.md`).

Those files are version-matched by construction: they live in the same tarball
as the `@alexkroman1/aai` the project resolved, so they cannot describe a
different release than the one being imported. That path is also what the
project's own `CLAUDE.md` points at: `aai init` writes a short pointer there
rather than a copy, because a copy is frozen at scaffold time and
`pnpm update @alexkroman1/aai` would leave it behind.

Anything this skill might say is **not** authoritative. A skill is installed in
a user's home directory and has no version at all, which is exactly why the
guidance is not repeated here.

## Types are the second source of truth

The shipped `.d.ts` files are in `node_modules/@alexkroman1/aai/dist/`. When the
guide and the types disagree, the types are what the compiler enforces — read
the declaration.

Most of the API is not on the root entry. The subpaths, generated from the
package's `exports` map:

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
- `@alexkroman1/aai/testing` — specs — `runTool`, `createToolContext`,
  `deployedAgent`, `expectDeployable`, and the step stubs
- `@alexkroman1/aai/testing/vitest` — the vitest-only half of `/testing`:
  anything that installs or restores a stub
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

Not imported by an `agent.ts` (hosts, the CLI and the studio; not covered by
semver for authors):

- `@alexkroman1/aai/protocol` — the client/server wire protocol
- `@alexkroman1/aai/coding-tools` — the workspace tool set for a `text: true`
  agent that edits code (`templates/coding-agent`)
- `@alexkroman1/aai/workspace-files` — what a project's files are, for the CLI
  and studio
- `@alexkroman1/aai/slugify` — the platform's slug rule
- `@alexkroman1/aai/manifest` — the build's agent-manifest lowering
- `@alexkroman1/aai/internal` — framework internals
- `@alexkroman1/aai/host-internal` — framework internals for the host runtime

<!-- END GENERATED aai subpaths -->

## Before reaching for a helper, check whether one exists

The SDK reifies the patterns agent code keeps re-deriving, and each exists
because it was hand-rolled several times first: `sessionSlot()` for typed state
shared across tool files, `slot.update` for a serialized async mutation,
`createKeyedLock()` for serialized work that is not a slot mutation,
`ToolFailure` / `isToolFailure()` for a failure the model should recover from,
`pushCapped()` for a capped append-only list, `omitUndefined()` for the optional
half of an object literal, and `createToolContext()` from
`@alexkroman1/aai/testing` for testing a tool's `execute`. The guide covers each
with a worked example; the point of this list is only that you look before
writing the pattern by hand.
