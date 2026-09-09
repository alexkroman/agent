# coding-tools

`@alexkroman1/aai/coding-tools` — the workspace tool set for an agent that edits code.

A FACADE. The subpath resolves here rather than at `coding-tools.ts`, which buys two
things the direct form could not. That module can be SPLIT as it grows without
moving the published entry point — the path an implementation file happens to
have is not a thing to promise anyone — and a name it gains next reaches the
public surface only when a line is added below, rather than the moment it is
written.

Named re-exports rather than `export *` for the second half of that: the
wildcard form re-exports whatever arrives, and needs a `noReExportAll`
suppression the escape-hatch ratchet only lets move down.

What is deliberately NOT here is the machinery UNDER the tools — the edit
matcher, the workspace grep, the capped child-process runner. This subpath's
promise is the tool SET a host installs and a model calls, and every name on
it is one an agent author writes. Of the three, only the RUNNER is published
at all (`@alexkroman1/aai/host-internal`, no semver promise), and only
because the guest harness spawns npm and the CLI bundler through it; the
other two have no consumer outside `coding-tools.ts` and publishing them
would be a surface with no reader.

## Functions

### createCodingTools()

```ts
function createCodingTools<N extends CodingToolName = CodingToolName>(options: CodingToolsOptions<N>): Record<N, ToolDef>;
```

Build a coding agent's tool set over one directory.

The result is keyed by the name the model calls, so it goes onto a definition
through `withTools` (a resolved registry) rather than through `tools/` files:
every tool here closes over THIS workspace, and a host serving more than one
builds the set per workspace for exactly that reason.

#### Type Parameters

##### N

`N` *extends* [`CodingToolName`](#codingtoolname) = [`CodingToolName`](#codingtoolname)

#### Parameters

##### options

[`CodingToolsOptions`](#codingtoolsoptions)\<`N`\>

#### Returns

`Record`\<`N`, [`ToolDef`](index.md#tooldef)\>

## Type Aliases

### CodingToolName

```ts
type CodingToolName = 
  | "list_files"
  | "read_file"
  | "glob"
  | "grep"
  | "write_file"
  | "edit_file"
  | "delete_file"
  | "bash"
  | "todo_write";
```

Every tool [createCodingTools](#createcodingtools) can build, by the name the model calls.

***

### CodingToolsOptions

```ts
type CodingToolsOptions<N extends CodingToolName = CodingToolName> = {
  afterWrite?: (rel: string) => Promise<string | undefined>;
  descriptions?: Partial<Record<CodingToolName, string>>;
  dir: string;
  env?: NodeJS.ProcessEnv;
  only?: readonly N[];
  validate?: (rel: string, content: string) => Promise<string | undefined>;
};
```

What [createCodingTools](#createcodingtools) takes.

Generic in the tool NAMES so the result is a record with literal keys rather
than an index signature: a `tools/read_file.ts` that default-exports
`codingTools.read_file` has to type-check as a `ToolDef`, and under
`noUncheckedIndexedAccess` a `Record<string, ToolDef>` hands back
`ToolDef | undefined`. Nothing has to name the parameter — it is inferred
from [CodingToolsOptions.only](#only), and defaults to every tool.

#### Type Parameters

##### N

`N` *extends* [`CodingToolName`](#codingtoolname) = [`CodingToolName`](#codingtoolname)

#### Properties

##### afterWrite?

```ts
optional afterWrite?: (rel: string) => Promise<string | undefined>;
```

Text appended to a successful `write_file` / `edit_file` result — the seam
a host hangs diagnostics on. Answer undefined when there is nothing to add.

###### Parameters

###### rel

`string`

###### Returns

`Promise`\<`string` \| `undefined`\>

##### descriptions?

```ts
optional descriptions?: Partial<Record<CodingToolName, string>>;
```

Per-tool description overrides, merged over [CODING\_TOOL\_DESCRIPTIONS](#coding_tool_descriptions).

##### dir

```ts
dir: string;
```

Absolute path of the workspace root. Nothing outside it is reachable.

##### env?

```ts
optional env?: NodeJS.ProcessEnv;
```

The `bash` child's environment. Defaults to this process's own.

##### only?

```ts
optional only?: readonly N[];
```

Build only these tools. Defaults to all nine.

A host that has a better tool of its own for one of these jobs names the
rest here, rather than building the full set and deleting a key — which
reads as an accident at the call site and cannot be type-checked.

##### validate?

```ts
optional validate?: (rel: string, content: string) => Promise<string | undefined>;
```

Refuse a write before it lands: answer a message to REJECT the content, or
undefined to let it through. The message is returned to the model verbatim,
so say what to do about it and not only what is wrong.

###### Parameters

###### rel

`string`

###### content

`string`

###### Returns

`Promise`\<`string` \| `undefined`\>

## Variables

### BASH\_TIMEOUT\_MAX\_MS

```ts
const BASH_TIMEOUT_MAX_MS: 300000 = 300000;
```

***

### BASH\_TIMEOUT\_MS

```ts
const BASH_TIMEOUT_MS: 60000 = 60000;
```

Default and maximum wall-clock for one `bash` command.

***

### CODING\_TOOL\_DESCRIPTIONS

```ts
const CODING_TOOL_DESCRIPTIONS: Readonly<Record<CodingToolName, string>>;
```

***

### GLOB\_LIMIT

```ts
const GLOB_LIMIT: 100 = 100;
```

Max `glob` results before the list is truncated, newest first.

***

### READ\_LIMIT

```ts
const READ_LIMIT: 2000 = 2000;
```

`read_file` paging default and hard cap, in lines.
