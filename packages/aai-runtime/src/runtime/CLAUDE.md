---
summary: >-
  The runtime object's session wiring: the keyed system-prompt suffix, dialogs
  and a roster's speakers
read_when: >-
  editing anything under `src/runtime/`
---

# aai-runtime `runtime/`

Package-wide rules are in [`../../CLAUDE.md`](../../CLAUDE.md); the flat
`src/` modules' in [`../CLAUDE.md`](../CLAUDE.md). Outside this directory,
import its `index.ts` only (`guard-invariants` rule 37).

## The system prompt: a keyed suffix over a cached base

**`SessionSystemPrompt.setSuffix(key, render)`** (`system-prompt.ts`)
is the extension point, and the slot is KEYED so a second installer cannot
silently delete another's suffix. Sources render in KEY order; an empty answer
contributes NOTHING (no blank line, no separator), and an empty suffix returns
the base string itself, so a session with nothing to say is byte-identical to
one with no sources. Adding an installer means picking a key.

The base prompt is cached per calendar day (`buildSystemPrompt` stamps the
date). `agent({ systemPrompt })` takes `AgentSystemPrompt`, whose resolver
needs the SESSION, so it is resolved here; a transport gets the assembled string
or a nullary thunk (`SystemPromptOption`). When each transport resolves is in
[`../transports/CLAUDE.md`](../transports/CLAUDE.md), "The system prompt is resolved
PER TURN".

## Dialogs are wired to a SESSION here

`dialogs.ts` bridges `agent({ dialogs })` to the session: events reach
it, per-state deadlines are armed, the active instruction becomes the
`"dialogs"` suffix, and three of five voice knobs apply (the other two are
refused with a warning naming the state). `dialog-knobs.ts` decides
which; `../transports/pipeline/knobs/dialog.ts` applies them. Everything else is
in [`../../DIALOG-CLAUDE.md`](../../DIALOG-CLAUDE.md).

## A roster's speakers are wired to a SESSION here

`personas.ts` installs the roster's active SPEAKING entry ("persona")
as the `"active-persona"` suffix (sorting ahead of `"dialogs"`; a roster with
no `speaks: true` entry installs nothing), pushes it to a transport that holds its
prompt as session state only when it CHANGED (re-rendered on `tool.completed`
and `state.updated`), and hands the pipeline the persona's
`toolChoice`/`temperature` as a `prepareStep` preparer between the agent's reset
and the dialog state's (`../transports/pipeline/knobs/persona.ts`). A stale slot
answers as the entry persona with a warning, never a throw.

**Do not narrow the tool set per step**: the AI SDK's `filterActiveTools`
narrows the EXECUTION set too, so a call to a hidden tool becomes a
`NoSuchToolError` instead of the SDK gate's handoff refusal. The knobs module
doc carries it.
