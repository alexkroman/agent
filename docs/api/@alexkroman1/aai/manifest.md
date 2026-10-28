# manifest

Manifest barrel — agent config conversion and tool schema handling.

Used by aai-cli (bundler) and aai-server (rpc-schemas). Generated bundle
entries call `toAgentConfig`, which is why this subpath is published.

## Functions

### agentToolsets()

```ts
function agentToolsets(def: ToolBearingDef): Toolset[];
```

Every toolset an agent definition carries, in precedence order: its `tools/`
files, then what `agent()` and a host step attached (`toolsets` — the roster,
MCP). A `dialog.tool` needs no layer here: its own `execute` refuses out of
state, and that check travels with the def wherever it is declared — a spec,
a subagent, a direct call. Builtins are the runtime's to append, since they
resolve against host options.

#### Parameters

##### def

[`ToolBearingDef`](#toolbearingdef)

#### Returns

[`Toolset`](#toolset-1)[]

***

### agentToolsToSchemas()

```ts
function agentToolsToSchemas(toolsets: readonly Toolset[]): ToolSchema[];
```

#### Parameters

##### toolsets

readonly [`Toolset`](#toolset-1)[]

#### Returns

[`ToolSchema`](#toolschema)[]

***

### composeToolsets()

```ts
function composeToolsets(sets: readonly Toolset[], onShadowed?: (name: string, kept: ToolSource, dropped: ToolSource) => void): ToolTable;
```

Compose toolsets, FIRST WINS: a later set's tool of an already-taken name is
dropped, and `onShadowed` hears about it — the precedence is the order.

#### Parameters

##### sets

readonly [`Toolset`](#toolset-1)[]

##### onShadowed?

(`name`: `string`, `kept`: [`ToolSource`](#toolsource), `dropped`: [`ToolSource`](#toolsource)) => `void`

#### Returns

[`ToolTable`](#tooltable)

***

### gateToolset()

```ts
function gateToolset(set: Toolset, gates: readonly ToolGate[]): Toolset;
```

Layer extra gates over a set — every gate must pass, the set's own first.

#### Parameters

##### set

[`Toolset`](#toolset-1)

##### gates

readonly [`ToolGate`](#toolgate)[]

#### Returns

[`Toolset`](#toolset-1)

***

### normalizeToolMessages()

```ts
function normalizeToolMessages(input: ToolMessagesInput | undefined): ToolMessages | undefined;
```

Author input → the wire shape, dropping every kind the tool did not declare.

Answers `undefined` for a tool with nothing to say, so a schema for an
ordinary tool is byte-identical to what it was before this field existed —
which is what keeps `messages` off every deployed agent's tool declarations
and out of every snapshot that did not opt in.

#### Parameters

##### input

[`ToolMessagesInput`](index.md#toolmessagesinput) \| `undefined`

#### Returns

[`ToolMessages`](index.md#toolmessages) \| `undefined`

***

### toAgentConfig()

```ts
function toAgentConfig(source: AgentConfigSource): {
  builtinTools?: readonly string[];
  clientInbox?: {
     sampleRate?: number;
  };
  errorPhrase?: string;
  greeting: string;
  idleTimeoutMs?: number;
  interruption?:   | "off"
     | {
     backoffMs?: number;
     continuationWindowMs?: number;
     minDurationMs?: number;
     minWords?: number;
     resumeFalseInterruption?: boolean;
   };
  listing?: string;
  llm?: ProviderDescriptor<string, Record<string, unknown>>;
  maxOutputTokens?: number;
  maxRetries?: number;
  maxSteps?: number;
  mcpServers?: Record<string, {
     allowedTools?: readonly string[];
     pinnedTools?: Record<string, string>;
     tokenEnv?: string;
     url?: string;
  }>;
  mode?: "s2s" | "pipeline" | "text" | "workflow-app";
  name: string;
  promptContext?: string;
  requiredEnv?: readonly string[];
  resetToolChoice?: boolean;
  s2s?: ProviderDescriptor<string, Record<string, unknown>>;
  silence?: {
     deadAirCoverMs?: number;
     nudge?: {
        afterMs: number;
        prompt?: string;
     };
  };
  startFailurePhrase?: string;
  stt?: ProviderDescriptor<string, Record<string, unknown>>;
  sttPrompt?: string;
  systemPrompt: string;
  telephony?: boolean | readonly string[];
  temperature?: number;
  toolChoice?:   | "auto"
     | "required"
     | "none"
     | {
     toolName: string;
     type: "tool";
   };
  tts?: ProviderDescriptor<string, Record<string, unknown>>;
  turnTaking?: {
     detection?: string;
     maxSilenceMs?: number;
     minSilenceMs?: number;
     preemptiveGeneration?: boolean;
     startSpeakingFloorMs?: number;
     userTurnLimit?: {
        maxDurationMs?: number;
        maxWords?: number;
     };
  };
  usageLimits?: {
     totalTokens?: number;
  };
  voicePresets?: readonly string[];
};
```

Convert an agent definition into its serializable [AgentConfig](#agentconfig),
injecting the default providers, deriving the session `mode`, and running
the cross-field validation rules. Called from generated bundle entries and
the runtime.

#### Parameters

##### source

[`AgentConfigSource`](#agentconfigsource)

#### Returns

```ts
{
  builtinTools?: readonly string[];
  clientInbox?: {
     sampleRate?: number;
  };
  errorPhrase?: string;
  greeting: string;
  idleTimeoutMs?: number;
  interruption?:   | "off"
     | {
     backoffMs?: number;
     continuationWindowMs?: number;
     minDurationMs?: number;
     minWords?: number;
     resumeFalseInterruption?: boolean;
   };
  listing?: string;
  llm?: ProviderDescriptor<string, Record<string, unknown>>;
  maxOutputTokens?: number;
  maxRetries?: number;
  maxSteps?: number;
  mcpServers?: Record<string, {
     allowedTools?: readonly string[];
     pinnedTools?: Record<string, string>;
     tokenEnv?: string;
     url?: string;
  }>;
  mode?: "s2s" | "pipeline" | "text" | "workflow-app";
  name: string;
  promptContext?: string;
  requiredEnv?: readonly string[];
  resetToolChoice?: boolean;
  s2s?: ProviderDescriptor<string, Record<string, unknown>>;
  silence?: {
     deadAirCoverMs?: number;
     nudge?: {
        afterMs: number;
        prompt?: string;
     };
  };
  startFailurePhrase?: string;
  stt?: ProviderDescriptor<string, Record<string, unknown>>;
  sttPrompt?: string;
  systemPrompt: string;
  telephony?: boolean | readonly string[];
  temperature?: number;
  toolChoice?:   | "auto"
     | "required"
     | "none"
     | {
     toolName: string;
     type: "tool";
   };
  tts?: ProviderDescriptor<string, Record<string, unknown>>;
  turnTaking?: {
     detection?: string;
     maxSilenceMs?: number;
     minSilenceMs?: number;
     preemptiveGeneration?: boolean;
     startSpeakingFloorMs?: number;
     userTurnLimit?: {
        maxDurationMs?: number;
        maxWords?: number;
     };
  };
  usageLimits?: {
     totalTokens?: number;
  };
  voicePresets?: readonly string[];
}
```

##### builtinTools?

```ts
optional builtinTools?: readonly string[];
```

##### clientInbox?

```ts
{
  sampleRate?: number;
}
```

##### errorPhrase?

```ts
optional errorPhrase?: string;
```

##### greeting

```ts
greeting: string;
```

##### idleTimeoutMs?

```ts
optional idleTimeoutMs?: number;
```

##### interruption?

```ts
optional interruption?: 
  | "off"
  | {
  backoffMs?: number;
  continuationWindowMs?: number;
  minDurationMs?: number;
  minWords?: number;
  resumeFalseInterruption?: boolean;
};
```

##### listing?

```ts
optional listing?: string;
```

##### llm?

```ts
optional llm?: ProviderDescriptor<string, Record<string, unknown>>;
```

##### maxOutputTokens?

```ts
optional maxOutputTokens?: number;
```

##### maxRetries?

```ts
optional maxRetries?: number;
```

##### maxSteps?

```ts
optional maxSteps?: number;
```

##### mcpServers?

```ts
optional mcpServers?: Record<string, {
  allowedTools?: readonly string[];
  pinnedTools?: Record<string, string>;
  tokenEnv?: string;
  url?: string;
}>;
```

##### mode?

```ts
optional mode?: "s2s" | "pipeline" | "text" | "workflow-app";
```

##### name

```ts
name: string;
```

##### promptContext?

```ts
optional promptContext?: string;
```

##### requiredEnv?

```ts
optional requiredEnv?: readonly string[];
```

##### resetToolChoice?

```ts
optional resetToolChoice?: boolean;
```

##### s2s?

```ts
optional s2s?: ProviderDescriptor<string, Record<string, unknown>>;
```

##### silence?

```ts
{
  deadAirCoverMs?: number;
  nudge?: {
     afterMs: number;
     prompt?: string;
  };
}
```

##### startFailurePhrase?

```ts
optional startFailurePhrase?: string;
```

##### stt?

```ts
optional stt?: ProviderDescriptor<string, Record<string, unknown>>;
```

##### sttPrompt?

```ts
optional sttPrompt?: string;
```

##### systemPrompt

```ts
systemPrompt: string;
```

##### telephony?

```ts
optional telephony?: boolean | readonly string[];
```

##### temperature?

```ts
optional temperature?: number;
```

##### toolChoice?

```ts
optional toolChoice?: 
  | "auto"
  | "required"
  | "none"
  | {
  toolName: string;
  type: "tool";
};
```

##### tts?

```ts
optional tts?: ProviderDescriptor<string, Record<string, unknown>>;
```

##### turnTaking?

```ts
{
  detection?: string;
  maxSilenceMs?: number;
  minSilenceMs?: number;
  preemptiveGeneration?: boolean;
  startSpeakingFloorMs?: number;
  userTurnLimit?: {
     maxDurationMs?: number;
     maxWords?: number;
  };
}
```

##### usageLimits?

```ts
{
  totalTokens?: number;
}
```

##### voicePresets?

```ts
optional voicePresets?: readonly string[];
```

***

### toolEntry()

```ts
function toolEntry(def: ToolDef): ToolsetEntry;
```

Classify one def into an entry: the ONE place a def's identity is inspected.
A `clientTool` (its brand) is executed by the page; everything else here.

#### Parameters

##### def

[`ToolDef`](index.md#tooldef)

#### Returns

[`ToolsetEntry`](#toolsetentry)

***

### toolRegistry()

```ts
function toolRegistry(modules: ToolModules): ToolRegistry;
```

Build a checked registry from already-loaded modules.

Synchronous, because the caller that matters most — the generated worker
entry — has the modules statically imported already, and a `Promise` there
would put top-level `await` in a bundle the guest loads.

#### Parameters

##### modules

[`ToolModules`](#toolmodules)

#### Returns

[`ToolRegistry`](#toolregistry)

***

### toolset()

```ts
function toolset(
   source: ToolSource, 
   tools: ToolMap, 
   gate?: ToolGate
): Toolset;
```

Build a [Toolset](#toolset-1) over a map of defs, optionally gated.

#### Parameters

##### source

[`ToolSource`](#toolsource)

##### tools

[`ToolMap`](index.md#toolmap)

##### gate?

[`ToolGate`](#toolgate)

#### Returns

[`Toolset`](#toolset-1)

***

### withTools()

```ts
function withTools<D extends {
  builtinTools?: readonly string[];
  tools: ToolRegistry;
  toolsets?: readonly Toolset[];
}>(def: D, registry: ToolRegistry): D;
```

Attach a registry to an agent definition, returning the def the runtime runs.

A NEW object rather than a mutation: the def a module default-exports is
shared (a spec imports the same one the entry does), and a loader quietly
rewriting it makes the order of two imports decide what an agent can do.

**It is also the seam every registry NOT assembled by a bundler goes on
through.** Two do. `withToolsDir` (`@alexkroman1/aai-runtime`) scans a real
directory for a self-hosted process and comes back here. And the studio's own
coding agent resolves its tool families from a session
(`aai-guest/studio-agent.ts`), which is what makes that honest rather than an
exception: a registry resolved from a session instead of from a directory,
attached the same way.

**Closing over a directory is NOT what puts a registry here** — this said so,
and `templates/coding-agent/` disproves it: nine tools that all close over one
directory, shipped as FILES, each re-exporting an entry from a registry
`shared.ts` builds once. What the studio has that a template does not is a
directory chosen per SESSION and re-materialized under a running process,
where a file's default export is evaluated once at import. The distinction is
LIFETIME, not closure, and it matters because the closure reading would tell
an author their tools cannot be files when they can.

A name the def ALREADY holds is an error. Through `agent()` that is now
unreachable — it returns an empty table and refuses a `tools` argument — so
what this catches is a hand-written `export default { … tools: {…} }` that
skipped `agent()`, and a second `withTools` over a def that already has one.

**A name the def declared as a BUILTIN is an error too, and that one an
author can reach.** `builtinTools: ["calculate"]` beside `tools/calculate.ts`
is one file name away at all times, filenames being the only thing here a
user picks freely — and it built clean: the runtime's merge drops the
colliding builtin (`mergeBuiltinSurface`), so the entry the author wrote did
nothing and the only trace was one `info` line in a session log, minted at the
first call rather than at the build. That is the same silence discovery was
introduced to kill ("forgetting one line was silent"), reached by the other
route, and it is the one collision where BOTH halves were declared on purpose
— so it is a contradiction to report rather than a precedence to apply.

Structural rather than `AgentDef`, and it hands back what it was given: a
caller keeps whatever else its def carries, and nothing this returns is
described by a type the caller did not already name. `builtinTools` joins the
constraint as optional and widened to `readonly string[]`, so a def that
carries none still passes and this module still names no builtin catalog.

**It also RECORDS each def's name** (`_testing-tool-names.ts`). This is the
one step every lowering goes through that pairs a def with the name the
model calls, and a spec handed the def later — `toolResultIn(calls, def)`,
`toolNameOf(def)` — has nowhere else to learn it. A `WeakMap` write per
tool, so a lowering that nobody tests costs nothing.

#### Type Parameters

##### D

`D` *extends* \{
  `builtinTools?`: readonly `string`[];
  `tools`: [`ToolRegistry`](#toolregistry);
  `toolsets?`: readonly [`Toolset`](#toolset-1)[];
\}

#### Parameters

##### def

`D`

##### registry

[`ToolRegistry`](#toolregistry)

#### Returns

`D`

***

### withWorkflows()

```ts
function withWorkflows<D extends object>(
   def: D, 
   registry: WorkflowRegistry, 
   options?: WithWorkflowsOptions
): D;
```

Attach a discovered registry to an agent definition, returning the def the
runtime runs — a NEW object, for `withTools`' reason (the def a module
exports is shared with every spec that imports it).

**An explicit declaration wins a clash, and says so.** `withTools` refuses a
name declared twice, because a tool's file IS its declaration and a second
one is a contradiction. A workflow's declaration of record is still
`agent({ workflows })`, and the common clash is benign — the author
registered `workflows/digest.ts`'s def as `digest` and the file ALSO
default-exports it, which is the same object under the same name. That case
is silent. A DIFFERENT def under a declared name keeps the declared one and
warns, naming the file, so the file's author learns it is not the one
running rather than discovering it from a run that behaves like the other.
The same def declared under ANOTHER name (`workflows: { nightly: digest }`
beside `workflows/digest.ts`) registers ONCE, under the declared name, with
a warning naming the file: a def under two names was listed twice by
`GET /workflows` and could be started as either.

Structural rather than `AgentDef`, and it hands back what it was given, as
`withTools` does.

#### Type Parameters

##### D

`D` *extends* `object`

#### Parameters

##### def

`D`

##### registry

[`WorkflowRegistry`](#workflowregistry)

##### options?

[`WithWorkflowsOptions`](#withworkflowsoptions)

#### Returns

`D`

***

### workflowRegistry()

```ts
function workflowRegistry(modules: WorkflowModules): WorkflowRegistry;
```

The workflows a `workflows/` directory declares, from its already-loaded
modules. Synchronous, like `toolRegistry`, so the generated entry carries no
top-level `await`.

A module that does not default-export a def is skipped (see the module
doc) — except a bodyless two-phase declaration, which is refused naming
`.body()`. One that is a def and is nested, misnamed or a duplicate is an
error naming the file.

#### Parameters

##### modules

[`WorkflowModules`](#workflowmodules)

#### Returns

[`WorkflowRegistry`](#workflowregistry)

## Interfaces

### ResolvedTool

One resolved name in a [ToolTable](#tooltable).

#### Properties

##### entry

```ts
readonly entry: ToolsetEntry;
```

##### name

```ts
readonly name: string;
```

##### toolset

```ts
readonly toolset: Toolset;
```

***

### ToolBearingDef

#### Properties

##### tools

```ts
readonly tools: ToolMap;
```

##### toolsets?

```ts
readonly optional toolsets?: readonly Toolset[];
```

***

### Toolset

A source of tools, as the runtime consumes it.

The advertised list is fixed per session on every transport (an S2S service
holds its tool list for the whole session), so a rule about WHEN a tool may
run is a [Toolset.gate](#gate) at the call — which is also where the model is
told why, and how to recover.

#### Methods

##### execute()

```ts
execute(
   name: string, 
   args: unknown, 
   ctx: ToolContext
): unknown;
```

Run `name`'s body with already-validated arguments. Gating is the caller's.

###### Parameters

###### name

`string`

###### args

`unknown`

###### ctx

[`ToolContext`](index.md#toolcontext)

###### Returns

`unknown`

##### gate()

```ts
gate(name: string, ctx: ToolContext): ToolRefusal | undefined;
```

`undefined` when `name` may run now; otherwise the refusal the model reads.

###### Parameters

###### name

`string`

###### ctx

[`ToolContext`](index.md#toolcontext)

###### Returns

[`ToolRefusal`](index.md#toolrefusal) \| `undefined`

##### list()

```ts
list(): Readonly<Record<string, ToolsetEntry>>;
```

Every tool this set advertises, by the name the model calls.

###### Returns

`Readonly`\<`Record`\<`string`, [`ToolsetEntry`](#toolsetentry)\>\>

#### Properties

##### source

```ts
readonly source: ToolSource;
```

***

### ToolsetEntry

One advertised tool: the def the model reads, and who executes it.

#### Properties

##### def

```ts
readonly def: ToolDef;
```

Description, schema, `messages` and `onError` — what the model and the executor read.

##### executor

```ts
readonly executor: ToolExecutor;
```

##### timeoutMs?

```ts
readonly optional timeoutMs?: number;
```

A per-call deadline the entry carries (a `clientTool`'s `timeoutMs`).

***

### ToolTable

Several toolsets composed into one name → tool lookup.

#### Methods

##### resolve()

```ts
resolve(name: string): ResolvedTool | undefined;
```

###### Parameters

###### name

`string`

###### Returns

[`ResolvedTool`](#resolvedtool) \| `undefined`

#### Properties

##### tools

```ts
readonly tools: readonly ResolvedTool[];
```

Every advertised tool, in precedence order.

## Type Aliases

### AgentConfig

```ts
type AgentConfig = z.infer<typeof AgentConfigSchema>;
```

JSON-safe subset of the agent definition — the canonical serializable
config that flows CLI → server → runtime unchanged.

***

### AgentConfigSource

```ts
type AgentConfigSource = Omit<AgentConfig, "mode" | "systemPrompt" | "promptContext" | "mcpServers"> & {
  mcpServers?: McpServers;
  mode?: AgentMode;
  promptContext?: AgentPromptContext;
  systemPrompt?: AgentSystemPrompt;
} & { [K in HostOnlyAgentField]?: unknown };
```

What [toAgentConfig](#toagentconfig) accepts: every serializable [AgentConfig](#agentconfig)
field plus the host-only fields the deny-list strips. `AgentDef` is assignable to this by
construction; the explicit `| undefined` on the host-only members keeps
spread call sites (`{...agent, stt: maybeUndefined}`) legal under
`exactOptionalPropertyTypes`.

#### Type Declaration

##### mcpServers?

```ts
optional mcpServers?: McpServers;
```

Wider than the wire's record for the same reason: an `McpServerConfig` may
carry a `url` RESOLVER and `headers`, both host-only. `toAgentConfig`
strips them (see `wireMcpServers`).

##### mode?

```ts
optional mode?: AgentMode;
```

See `AgentDef.mode`; `undefined` from a spread means the default.

##### promptContext?

```ts
optional promptContext?: AgentPromptContext;
```

The same widening for `promptContext`, whose function half is dropped the same way.

##### systemPrompt?

```ts
optional systemPrompt?: AgentSystemPrompt;
```

Wider than the config's own `string`, because `AgentDef.systemPrompt`
may be a RESOLVER — a function this layer cannot serialize and must not
hand onward. Widened here rather than on [AgentConfig](#agentconfig) so `AgentDef`
stays assignable to this by construction, which is what every
`toAgentConfig(agent)` call site relies on. `toAgentConfig` drops it (see
`staticSystemPrompt`); the runtime holds the agent's own module and asks
the function per request.

***

### HostOnlyAgentField

```ts
type HostOnlyAgentField = typeof HOST_ONLY_AGENT_FIELDS[number];
```

A host-only `AgentDef` field name stripped by `toAgentConfig` (`tools`, `events`, …).

***

### ResolvedAgentDef

```ts
type ResolvedAgentDef = AgentDef & {
  toolsets?: readonly Toolset[];
};
```

An [AgentDef](index.md#agentdef) as the RUNTIME holds it: plus every toolset beyond the
`tools/` files — RESOLVED, never authored. `agent()` attaches the roster's
and `withMcpTools` an MCP server's; read the whole table through
[agentToolsets](#agenttoolsets). Not on the authoring surface: an author never names a
toolset, so the public `AgentDef` does not carry the field's type.

#### Type Declaration

##### toolsets?

```ts
readonly optional toolsets?: readonly Toolset[];
```

***

### SessionMode

```ts
type SessionMode = "s2s" | "pipeline" | "text";
```

Session mode derived from which provider fields are set.

`toAgentConfig`, `createRuntime`, and the server's `IsolateConfigSchema`
all use `assertProviderTriple` so there's one source of truth for the
validation.

`"text"` is the one mode with no audio path at all: the agent is an LLM,
a system prompt and its tools, driven by `createTextAgent`
(`@alexkroman1/aai-runtime`) over a message list rather than by a
transport over a socket.

***

### ToolExecutor

```ts
type ToolExecutor = "host" | "client";
```

Who runs a tool's body: this process (`"host"`), or the connected browser page
(`"client"`, a `clientTool` — the call waits for the page's `tool_result`).

***

### ToolGate

```ts
type ToolGate = (name: string, def: ToolDef, ctx: ToolContext) => ToolRefusal | undefined;
```

A gate over one def — what [toolset](#toolset-2) composes into [Toolset.gate](#gate).

#### Parameters

##### name

`string`

##### def

[`ToolDef`](index.md#tooldef)

##### ctx

[`ToolContext`](index.md#toolcontext)

#### Returns

[`ToolRefusal`](index.md#toolrefusal) \| `undefined`

***

### ToolModules

```ts
type ToolModules = Readonly<Record<string, unknown>>;
```

`path → module namespace`, which is what both sources produce: Vite's
`import.meta.glob` (eager) and the static import list the CLI generates.

***

### ToolRegistry

```ts
type ToolRegistry = Readonly<Record<string, ToolDef>>;
```

A checked set of tools, keyed by the name the model calls.

***

### ToolSchema

```ts
type ToolSchema = {
  description: string;
  effect?: ToolEffect;
  messages?: ToolMessages;
  name: string;
  parameters: JSONSchema7;
  type: "function";
  ui?: ToolUi;
};
```

A tool declaration in wire form: name, description, and JSON Schema
parameters — the serializable counterpart of `ToolDef`.

#### Properties

##### description

```ts
description: string;
```

##### effect?

```ts
optional effect?: ToolEffect;
```

What the tool does to the world — see `ToolDef.effect`. A host-mode client
declaring its own tools sets it the same way; an MCP tool's comes from its
server's `readOnlyHint`. Never sent to the model.

##### messages?

```ts
optional messages?: ToolMessages;
```

The tool's spoken messages, NORMALIZED — see [ToolMessages](index.md#toolmessages).

It rides on the wire declaration rather than beside it because that is what
makes the feature mean the same thing in every mode: the deployed guest
builds this from the agent's own `ToolDef`s, and a host-mode client that
supplies its own tool declarations gets the behaviour by declaring the
field. Nothing here reaches the model — `toVercelTools` passes `name`,
`description` and `parameters` to the provider and reads this itself.

Absent for every tool that declares none, which is what keeps an ordinary
tool's wire declaration byte-identical to what it was before the field
existed.

##### name

```ts
name: string;
```

##### parameters

```ts
parameters: JSONSchema7;
```

##### type

```ts
type: "function";
```

##### ui?

```ts
optional ui?: ToolUi;
```

How a page displays the tool — see `ToolUi` (`tool-def.ts`). Rides here
for the reason `messages` does: the deployed guest builds the declaration
from the agent's own `ToolDef`s, and the pre-connection client config
carries the same hints (`toolUiMap`, `tool-ui.ts`), so the default client
renders the same thing everywhere. Absent for a tool that declares none.

***

### ToolSource

```ts
type ToolSource = "files" | "builtin" | "mcp" | "roster" | "subagent";
```

Where a [Toolset](#toolset-1)'s tools come from — for a log line, a collision
message, and a spec. It decides nothing about execution; the entry does.

***

### WithWorkflowsOptions

```ts
type WithWorkflowsOptions = {
  warn?: (message: string) => void;
};
```

**`Input`**

What [withWorkflows](#withworkflows) may be told.

#### Properties

##### warn?

```ts
optional warn?: (message: string) => void;
```

Where a name-clash warning goes. Default `console.warn`, which under
`aai build` and `aai dev` reaches the terminal; the studio passes its own.

###### Parameters

###### message

`string`

###### Returns

`void`

***

### WorkflowModules

```ts
type WorkflowModules = Readonly<Record<string, unknown>>;
```

`path → module namespace`, as both sources produce it: the static import
list the CLI generates, and a spec's `import.meta.glob` (eager).

***

### WorkflowRegistry

```ts
type WorkflowRegistry = Readonly<Record<string, WorkflowDef>>;
```

A checked set of workflows, keyed by the name they are started under.

## Variables

### HOST\_ONLY\_AGENT\_FIELDS

```ts
const HOST_ONLY_AGENT_FIELDS: readonly ["tools", "syncState", "workflows", "roster", "toolsets", "dialogs", "events", "inputGuardrails", "outputGuardrails", "sessionContext", "onSessionEnd", "routes"];
```

`AgentDef` fields that must never cross the serialization boundary — the
single deny-list [toAgentConfig](#toagentconfig) strips. Everything else on the agent
definition flows into [AgentConfig](#agentconfig) by default, so a new serializable
field works CLI → server → runtime without touching a mapper. A field added
to `AgentDef` must appear either in `AgentConfigSchema` or here — the
type-level guard in the internal-types test enforces that subtraction.

It cannot catch a SUPERFLUOUS entry, which is the other direction and the one
that went stale: `state` sat here after `AgentDef.state` was deleted with the
`ctx.state` bag, denying a key nothing produces and telling every reader the
bag still exists. An entry here is a claim that `AgentDef` has that field.

## References

### ToolCompletionMessage

Re-exports [ToolCompletionMessage](index.md#toolcompletionmessage)

***

### ToolDelayedMessage

Re-exports [ToolDelayedMessage](index.md#tooldelayedmessage)

***

### ToolMessageCondition

Re-exports [ToolMessageCondition](index.md#toolmessagecondition)

***

### ToolMessages

Re-exports [ToolMessages](index.md#toolmessages)

***

### ToolMessagesInput

Re-exports [ToolMessagesInput](index.md#toolmessagesinput)

***

### ToolStartMessage

Re-exports [ToolStartMessage](index.md#toolstartmessage)
