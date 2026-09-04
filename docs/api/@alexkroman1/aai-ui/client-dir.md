# client-dir

Filesystem location of the prebuilt default client — **Node only**.

Its own subpath rather than the root barrel because it imports `node:module`
and `node:path`: the root export is browser code, and pulling Node builtins
into it would break every bundler that consumes this package.

This exists because locating the directory is otherwise three lines of module
archaeology plus knowledge of an internal `dist/` layout, and everybody
serving the default UI has to write them — `aai-cli`'s dev server had its own
copy, as did every self-hosted example. Three places that would all silently
serve nothing if the build output moved.

## Functions

### defaultClientDir()

```ts
function defaultClientDir(): string;
```

Absolute path to the prebuilt browser client's static files — pass it to
`createRuntimeServer`/`createAgentServer` as `clientDir`.

A function, not a constant: resolution touches the module graph and throws
when the package is missing, and a module-level constant would move that
failure to import time — where it fires for callers that never wanted the
client, and before any of their own error handling is in place.

Resolved through this package's own `package.json` rather than relative to
this module, so it lands in the same place whether the caller resolved the
`@dev/source` TypeScript entry or the compiled one under `dist/`.

#### Returns

`string`

#### Example

```ts
import { agent } from "@alexkroman1/aai";
import { createAgentServer } from "@alexkroman1/aai-runtime";
import { defaultClientDir } from "@alexkroman1/aai-ui/client-dir";

const server = createAgentServer({
  agent: agent({ name: "Support" }),
  env: {},
  clientDir: defaultClientDir(),
});
```
