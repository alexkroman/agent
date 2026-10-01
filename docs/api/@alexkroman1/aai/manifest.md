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
MCP) — each layered with the agent's dialog gates, so a `dialog.tool` refuses
through [Toolset.gate](index.md#gate-1) wherever it is declared. Builtins are the
runtime's to append, since they resolve against host options.

#### Parameters

##### def

[`ToolBearingDef`](#toolbearingdef)

#### Returns

[`Toolset`](index.md#toolset)[]

***

### agentToolsToSchemas()

```ts
function agentToolsToSchemas(toolsets: readonly Toolset[]): ToolSchema[];
```

#### Parameters

##### toolsets

readonly [`Toolset`](index.md#toolset)[]

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

readonly [`Toolset`](index.md#toolset)[]

##### onShadowed?

(`name`: `string`, `kept`: [`ToolSource`](index.md#toolsource), `dropped`: [`ToolSource`](index.md#toolsource)) => `void`

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

[`Toolset`](index.md#toolset)

##### gates

readonly [`ToolGate`](#toolgate)[]

#### Returns

[`Toolset`](index.md#toolset)

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
  deadAirCoverMs?: number;
  description?: string;
  errorPhrase?: string;
  greeting: string;
  idleTimeoutMs?: number;
  interruptionBackoffMs?: number;
  interruptionMinDurationMs?: number;
  llm?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  maxOutputTokens?: number;
  maxRetries?: number;
  maxSteps?: number;
  mcpServers?: Record<string, {
     allowedTools?: readonly string[];
     pinnedTools?: Record<string, string>;
     tokenEnv?: string;
     url?: string;
  }>;
  minBargeInWords?: number;
  mode?: "s2s" | "text" | "pipeline";
  name: string;
  page?: "voice" | "static";
  preemptiveGeneration?: boolean;
  requiredEnv?: readonly string[];
  resetToolChoice?: boolean;
  resumeFalseInterruption?: boolean;
  s2s?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  silencePrompt?: string;
  silenceTimeoutMs?: number;
  startFailurePhrase?: string;
  startSpeakingFloorMs?: number;
  stt?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  sttPrompt?: string;
  systemPrompt: string;
  telephony?: boolean | readonly string[];
  temperature?: number;
  text?: true;
  toolChoice?:   | "auto"
     | "required"
     | "none"
     | {
     toolName: string;
     type: "tool";
   };
  tts?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  turnDetection?: string;
  usageLimits?: {
     totalTokens?: number;
  };
  userTurnLimit?: {
     maxDurationMs?: number;
     maxWords?: number;
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
  deadAirCoverMs?: number;
  description?: string;
  errorPhrase?: string;
  greeting: string;
  idleTimeoutMs?: number;
  interruptionBackoffMs?: number;
  interruptionMinDurationMs?: number;
  llm?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  maxOutputTokens?: number;
  maxRetries?: number;
  maxSteps?: number;
  mcpServers?: Record<string, {
     allowedTools?: readonly string[];
     pinnedTools?: Record<string, string>;
     tokenEnv?: string;
     url?: string;
  }>;
  minBargeInWords?: number;
  mode?: "s2s" | "text" | "pipeline";
  name: string;
  page?: "voice" | "static";
  preemptiveGeneration?: boolean;
  requiredEnv?: readonly string[];
  resetToolChoice?: boolean;
  resumeFalseInterruption?: boolean;
  s2s?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  silencePrompt?: string;
  silenceTimeoutMs?: number;
  startFailurePhrase?: string;
  startSpeakingFloorMs?: number;
  stt?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  sttPrompt?: string;
  systemPrompt: string;
  telephony?: boolean | readonly string[];
  temperature?: number;
  text?: true;
  toolChoice?:   | "auto"
     | "required"
     | "none"
     | {
     toolName: string;
     type: "tool";
   };
  tts?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  turnDetection?: string;
  usageLimits?: {
     totalTokens?: number;
  };
  userTurnLimit?: {
     maxDurationMs?: number;
     maxWords?: number;
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

##### deadAirCoverMs?

```ts
optional deadAirCoverMs?: number;
```

##### description?

```ts
optional description?: string;
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

##### interruptionBackoffMs?

```ts
optional interruptionBackoffMs?: number;
```

##### interruptionMinDurationMs?

```ts
optional interruptionMinDurationMs?: number;
```

##### llm?

```ts
{
  kind: string;
  options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}
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

##### minBargeInWords?

```ts
optional minBargeInWords?: number;
```

##### mode?

```ts
optional mode?: "s2s" | "text" | "pipeline";
```

##### name

```ts
name: string;
```

##### page?

```ts
optional page?: "voice" | "static";
```

##### preemptiveGeneration?

```ts
optional preemptiveGeneration?: boolean;
```

##### requiredEnv?

```ts
optional requiredEnv?: readonly string[];
```

##### resetToolChoice?

```ts
optional resetToolChoice?: boolean;
```

##### resumeFalseInterruption?

```ts
optional resumeFalseInterruption?: boolean;
```

##### s2s?

```ts
{
  kind: string;
  options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}
```

##### silencePrompt?

```ts
optional silencePrompt?: string;
```

##### silenceTimeoutMs?

```ts
optional silenceTimeoutMs?: number;
```

##### startFailurePhrase?

```ts
optional startFailurePhrase?: string;
```

##### startSpeakingFloorMs?

```ts
optional startSpeakingFloorMs?: number;
```

##### stt?

```ts
{
  kind: string;
  options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}
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

##### text?

```ts
optional text?: true;
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
{
  kind: string;
  options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}
```

##### turnDetection?

```ts
optional turnDetection?: string;
```

##### usageLimits?

```ts
{
  totalTokens?: number;
}
```

##### userTurnLimit?

```ts
{
  maxDurationMs?: number;
  maxWords?: number;
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

[`ToolsetEntry`](index.md#toolsetentry)

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

Build a [Toolset](index.md#toolset) over a map of defs, optionally gated.

#### Parameters

##### source

[`ToolSource`](index.md#toolsource)

##### tools

[`ToolMap`](index.md#toolmap)

##### gate?

[`ToolGate`](#toolgate)

#### Returns

[`Toolset`](index.md#toolset)

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

#### Type Parameters

##### D

`D` *extends* \{
  `builtinTools?`: readonly `string`[];
  `tools`: [`ToolRegistry`](#toolregistry);
  `toolsets?`: readonly [`Toolset`](index.md#toolset)[];
\}

#### Parameters

##### def

`D`

##### registry

[`ToolRegistry`](#toolregistry)

#### Returns

`D`

## Interfaces

### DialogToolGate

A dialog, as far as gating goes: it refuses a def it minted (`dialog.tool`)
outside its `when` states, and answers `undefined` for anything else.

#### Methods

##### gate()

```ts
gate(tool: ToolDef, ctx: SlotHolder): ToolRefusal | undefined;
```

###### Parameters

###### tool

[`ToolDef`](index.md#tooldef)

###### ctx

[`SlotHolder`](index.md#slotholder)

###### Returns

[`ToolRefusal`](index.md#toolrefusal) \| `undefined`

***

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

What [agentToolsets](#agenttoolsets) reads off a definition.

#### Properties

##### dialogs?

```ts
readonly optional dialogs?: readonly DialogToolGate[];
```

##### tools

```ts
readonly tools: ToolMap;
```

##### toolsets?

```ts
readonly optional toolsets?: readonly Toolset[];
```

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
type AgentConfigSource = Omit<AgentConfig, "mode" | "systemPrompt" | "mcpServers"> & {
  mcpServers?: McpServers;
  systemPrompt?: AgentSystemPrompt;
} & { [K in HostOnlyAgentField]?: unknown };
```

What [toAgentConfig](#toagentconfig) accepts: every serializable [AgentConfig](#agentconfig)
field (`mode` excepted — it is derived, never supplied) plus the host-only
fields the deny-list strips. `AgentDef` is assignable to this by
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

### ToolGate

```ts
type ToolGate = (name: string, def: ToolDef, ctx: ToolContext) => ToolRefusal | undefined;
```

A gate over one def — what [toolset](#toolset-1) composes into [Toolset.gate](index.md#gate-1).

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
type ToolRegistry = Readonly<Record<string, ToolDef<ToolInputSchema>>>;
```

A checked set of tools, keyed by the name the model calls.

***

### ToolSchema

```ts
type ToolSchema = {
  description: string;
  messages?: ToolMessages;
  name: string;
  parameters: JSONSchema7;
  type: "function";
};
```

A tool declaration in wire form: name, description, and JSON Schema
parameters — the serializable counterpart of `ToolDef`.

#### Properties

##### description

```ts
description: string;
```

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
