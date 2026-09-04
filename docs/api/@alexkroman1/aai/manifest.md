# manifest

Manifest barrel — agent config conversion and tool schema handling.

Used by aai-cli (bundler) and aai-server (rpc-schemas). Generated bundle
entries call `toAgentConfig`, which is why this subpath is published.

## Functions

### agentToolsToSchemas()

```ts
function agentToolsToSchemas(tools: Readonly<Record<string, ToolDef>>): ToolSchema[];
```

#### Parameters

##### tools

`Readonly`\<`Record`\<`string`, [`ToolDef`](index.md#tooldef)\>\>

#### Returns

[`ToolSchema`](#toolschema)[]

***

### assertPipelineTuning()

```ts
function assertPipelineTuning(mode: SessionMode, tuning: PipelineTuning): void;
```

#### Parameters

##### mode

[`SessionMode`](#sessionmode)

##### tuning

`PipelineTuning`

#### Returns

`void`

***

### toAgentConfig()

```ts
function toAgentConfig(source: AgentConfigSource): {
  builtinTools?: readonly (
     | "web_search"
     | "visit_webpage"
     | "get_page_design"
     | "fetch_json"
     | "run_code"
     | "think"
     | "remember"
     | "recall"
    | "calculate")[];
  deadAirCoverMs?: number;
  errorPhrase?: string;
  greeting: string;
  idleTimeoutMs?: number;
  interruptionMinDurationMs?: number;
  llm?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  maxSteps?: number;
  minBargeInWords?: number;
  mode?: "text" | "s2s" | "pipeline";
  name: string;
  page?: "voice" | "static";
  preemptiveGeneration?: boolean;
  requiredEnv?: readonly string[];
  resumeFalseInterruption?: boolean;
  s2s?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  silencePrompt?: string;
  silenceTimeoutMs?: number;
  startFailurePhrase?: string;
  stt?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  sttPrompt?: string;
  systemPrompt: string;
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
  builtinTools?: readonly (
     | "web_search"
     | "visit_webpage"
     | "get_page_design"
     | "fetch_json"
     | "run_code"
     | "think"
     | "remember"
     | "recall"
    | "calculate")[];
  deadAirCoverMs?: number;
  errorPhrase?: string;
  greeting: string;
  idleTimeoutMs?: number;
  interruptionMinDurationMs?: number;
  llm?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  maxSteps?: number;
  minBargeInWords?: number;
  mode?: "text" | "s2s" | "pipeline";
  name: string;
  page?: "voice" | "static";
  preemptiveGeneration?: boolean;
  requiredEnv?: readonly string[];
  resumeFalseInterruption?: boolean;
  s2s?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  silencePrompt?: string;
  silenceTimeoutMs?: number;
  startFailurePhrase?: string;
  stt?: {
     kind: string;
     options: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  };
  sttPrompt?: string;
  systemPrompt: string;
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
}
```

##### builtinTools?

```ts
optional builtinTools?: readonly (
  | "web_search"
  | "visit_webpage"
  | "get_page_design"
  | "fetch_json"
  | "run_code"
  | "think"
  | "remember"
  | "recall"
  | "calculate")[];
```

##### deadAirCoverMs?

```ts
optional deadAirCoverMs?: number;
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

##### maxSteps?

```ts
optional maxSteps?: number;
```

##### minBargeInWords?

```ts
optional minBargeInWords?: number;
```

##### mode?

```ts
optional mode?: "text" | "s2s" | "pipeline";
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

### withTools()

```ts
function withTools<D extends {
  builtinTools?: readonly string[];
  tools: ToolRegistry;
}>(def: D, registry: ToolRegistry): D;
```

Attach a registry to an agent definition, returning the def the runtime runs.

A NEW object rather than a mutation: the def a module default-exports is
shared (a spec imports the same one the entry does), and a loader quietly
rewriting it makes the order of two imports decide what an agent can do.

**It is also the seam every registry NOT assembled by a bundler goes on
through.** Two do. `withToolsDir` (`@alexkroman1/aai-runtime`) scans a real
directory for a self-hosted process and comes back here. And the studio's own
coding agent builds four tool families per turn, every one of them closed
over a single session's workspace directory (`aai-guest/studio-agent.ts`) —
those cannot be files at all, and this is what makes that honest rather than
an exception: a registry resolved from a session instead of from a directory,
attached the same way.

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
\}

#### Parameters

##### def

`D`

##### registry

[`ToolRegistry`](#toolregistry)

#### Returns

`D`

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
type AgentConfigSource = Omit<AgentConfig, "mode"> & { [K in HostOnlyAgentField]?: unknown };
```

What [toAgentConfig](#toagentconfig) accepts: every serializable [AgentConfig](#agentconfig)
field (`mode` excepted — it is derived, never supplied) plus the host-only
fields the deny-list strips. `AgentDef` is assignable to this by
construction; the explicit `| undefined` on the host-only members keeps
spread call sites (`{...agent, stt: maybeUndefined}`) legal under
`exactOptionalPropertyTypes`.

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
const HOST_ONLY_AGENT_FIELDS: readonly ["tools", "syncState", "workflows", "events"];
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
