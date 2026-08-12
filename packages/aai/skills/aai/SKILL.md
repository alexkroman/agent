---
name: aai
description: Build voice agents with the aai SDK. Use when creating, editing, or debugging an aai agent — agent.ts, tools, session state, STT/TTS/LLM/S2S providers, the browser client, or the aai CLI.
---

# aai

aai is a voice-agent development kit. An agent is a directory containing
`agent.ts`; the `aai` CLI bundles it and deploys it to the managed platform, or
`node server.mjs` runs it standalone.

## Source of truth

**The complete guide ships inside the installed package. Read it — do not work
from this file.**

```text
node_modules/@alexkroman1/aai/AGENT_GUIDE.md
```

That file is version-matched by construction: it lives in the same tarball as
the `@alexkroman1/aai` the project resolved, so it cannot describe a different
release than the one being imported. Read it before writing any aai code.

Two other copies exist and are **not** authoritative for an installed project:

- `CLAUDE.md` in the project root. Written by `aai init` and correct on day one,
  but frozen at scaffold time — `pnpm update @alexkroman1/aai` moves the SDK and
  leaves it behind. Prefer the file above whenever the two disagree.
- Anything this skill might say about the API. A skill is installed in a user's
  home directory and has no version at all, which is exactly why the guidance is
  not repeated here.

## Types are the second source of truth

Every published entry point has a committed API report under `etc/` in this
repository (`pnpm api-report`), and the shipped `.d.ts` files are in
`node_modules/@alexkroman1/aai/dist/`. When the guide and the types disagree,
the types are what the compiler enforces — read the declaration.

The subpath exports are worth knowing about, because most of the API is not on
the root entry: `@alexkroman1/aai/utils`, `/testing`, `/protocol`, `/runtime`,
`/manifest`, `/stt`, `/tts`, `/llm`, `/s2s`, `/tools`, `/workspace-files`,
`/slugify`. The guide's own table says which is which.

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
