# Type Safety QA Report

## Summary

Audit of all four workspace packages (`aai`, `aai-ui`, `aai-cli`, `aai-server`) for type safety issues. Found 15 concrete issues ranging from unsafe type assertions and missing null checks to untyped `JSON.parse` results and overly loose generics. The codebase is generally well-typed, but several patterns -- particularly around `as unknown as` double casts, unvalidated `JSON.parse` calls, and `any` in listener signatures -- introduce risks of runtime type mismatches.

## Issues Found

### Issue 1: Unsafe `as unknown as MetricReader` double cast on PrometheusExporter
- **File**: `packages/aai-server/src/metrics.ts:49`
- **Severity**: Medium
- **Description**: `(exporter as unknown as MetricReader).collect()` bypasses the type system entirely. If the `PrometheusExporter` API changes and `collect()` is removed or its signature changes, this will fail at runtime with no compile-time warning. The same pattern repeats at line 92 with `dp as unknown as { value: HistogramValue }`.
- **Recommendation**: Check if `PrometheusExporter` exposes a `collect()` method in its public type. If it does, cast to a narrower interface. If not, file an upstream issue or use a wrapper that safely checks for the method's existence at runtime.

### Issue 2: `dp.attributes` cast to `Record<string, string>` without validation
- **File**: `packages/aai-server/src/metrics.ts:77`
- **Severity**: Medium
- **Description**: `const labels = dp.attributes as Record<string, string>` assumes all attribute values are strings. OTel attributes can be `string | number | boolean | string[]` etc. If a non-string attribute is present, `formatLabels()` will silently produce incorrect Prometheus output (e.g. `agent="[object Object]"`).
- **Recommendation**: Filter or convert attribute values to strings explicitly, e.g. `String(v)` for each value, or validate that all values are strings before casting.

### Issue 3: `server.address()` cast to `{ port: number }` without null check
- **File**: `packages/aai-server/src/sandbox-sidecar.ts:184`
- **Severity**: High
- **Description**: `const addr = server.address() as { port: number }` -- `server.address()` can return `null` (if the server is not listening) or a `string` (for pipe/Unix socket). Casting directly to `{ port: number }` will cause a runtime crash if the server fails to bind.
- **Recommendation**: Add a null/type check: `const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('...');`

### Issue 4: `err as { status?: number }` unguarded cast in error handler
- **File**: `packages/aai-server/src/sandbox-sidecar.ts:165`
- **Severity**: Low
- **Description**: `(err as { status?: number }).status` casts the caught error without verifying it is an object. If `err` is a primitive (e.g. a thrown string), accessing `.status` will return `undefined` which is handled, but the `as` cast is still fragile.
- **Recommendation**: Use a type guard: `typeof err === 'object' && err !== null && 'status' in err`.

### Issue 5: Untyped `JSON.parse` results in `_link.ts`
- **File**: `packages/aai-cli/_link.ts:25,31`
- **Severity**: Medium
- **Description**: `JSON.parse(fs.readFileSync(...))` returns `any`. The `pkgJson` and `localPkg` variables are implicitly `any`, allowing arbitrary property access without type checking. On line 32, `localPkg.name as string` is a downstream symptom of this -- the cast is needed because the parse result is untyped.
- **Recommendation**: Define a minimal type for the expected package.json shape (e.g. `{ name: string; dependencies?: Record<string, string> }`) and validate or cast the parsed result.

### Issue 6: `JSON.parse` in `cli.ts` returns untyped result
- **File**: `packages/aai-cli/cli.ts:17`
- **Severity**: Low
- **Description**: `const pkgJson = JSON.parse(findPkgJson(cliDir))` -- the result is `any`. `pkgJson.version` on line 18 is accessed without any type narrowing. If the package.json format changes or the file is malformed, this will throw a confusing runtime error.
- **Recommendation**: Type the parsed result or use a Zod schema to validate the expected shape.

### Issue 7: `any` type in `MockWebSocket.addEventListener` implementation signature
- **File**: `packages/aai/_mock-ws.ts:63`
- **Severity**: Low
- **Description**: The implementation signature uses `listener: any` to encompass all overloads. While this is annotated with a biome-ignore comment, it means that callers who bypass the overload signatures (e.g. via a generic reference) will not get type checking on the listener parameter.
- **Recommendation**: Use a union type for the listener parameter (e.g. `EventListener | EventListenerObject`) instead of `any`, or keep the overloads as the sole public API and mark the implementation as truly internal.

### Issue 8: Unsafe `as ArrayBuffer` cast on `e.data.buffer`
- **File**: `packages/aai-ui/audio.ts:102`
- **Severity**: Medium
- **Description**: `new Uint8Array(e.data.buffer as ArrayBuffer)` -- `e.data.buffer` has type `ArrayBufferLike` which could be a `SharedArrayBuffer`. If the worklet ever sends data backed by shared memory, the `Uint8Array` constructor would still work, but the `as ArrayBuffer` cast silently hides the type mismatch.
- **Recommendation**: Use `ArrayBufferLike` or check `instanceof ArrayBuffer` before casting.

### Issue 9: `chunk.buffer as ArrayBuffer` in client-handler
- **File**: `packages/aai-ui/client-handler.ts:147`
- **Severity**: Medium
- **Description**: `this.#voiceIO()?.enqueue(chunk.buffer as ArrayBuffer)` -- same issue as Issue 8. `Uint8Array.buffer` returns `ArrayBufferLike`, not necessarily `ArrayBuffer`. Additionally, `chunk.buffer` may have a different `byteOffset` and `byteLength` than the typed array view, potentially sending extra bytes to the playback pipeline.
- **Recommendation**: Use `chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)` to get a correctly-sized `ArrayBuffer`, and avoid the unsafe cast.

### Issue 10: `config as ReadyConfig` cast after destructuring removes `type`
- **File**: `packages/aai-ui/client-handler.ts:196`
- **Severity**: Low
- **Description**: After `const { type: _, ...config } = msg;`, the spread result is cast `as ReadyConfig`. The `ServerMessage` config type includes `audioFormat: string` but `ReadyConfig` expects `audioFormat: "pcm16"` (a literal). The cast silently widens the literal check, meaning an unsupported audio format would pass through without error.
- **Recommendation**: Validate `config` against `ReadyConfigSchema` (Zod) instead of asserting the type.

### Issue 11: `agentDef as AgentDef` cast bypasses structural validation
- **File**: `packages/aai-cli/_server-common.ts:18`
- **Severity**: Medium
- **Description**: `loadAgentDef` does a minimal check (`agentDef.name` exists) then casts `agentDef as AgentDef`. The `AgentDef` type has many required fields (`instructions`, `greeting`, `tools`, `maxSteps`, etc.) that are not checked. A malformed agent module would pass the check but fail later at runtime.
- **Recommendation**: Use a Zod schema or a more thorough structural check to validate all required `AgentDef` fields before casting.

### Issue 12: Multiple unsafe `as` casts in `buildHookInvoker` for hook results
- **File**: `packages/aai-server/src/sandbox.ts:214-249`
- **Severity**: Medium
- **Description**: Throughout `buildHookInvoker`, the generic `hook()` function returns `Promise<unknown>`, which is then cast to specific types: `as Promise<void>` (lines 214-218), `result as string | undefined` (line 231), `result as ToolInterceptResult` (line 239), `(result as string) ?? text` (line 249). None of these casts are validated. If the isolate returns unexpected data, these casts will silently propagate wrong types.
- **Recommendation**: Validate hook results with Zod schemas (similar to how `ToolCallResponseSchema` and `HookResponseSchema` are used elsewhere) before casting.

### Issue 13: `(err as NodeJS.ErrnoException).code` unchecked error cast
- **File**: `packages/aai-cli/_init.ts:95`
- **Severity**: Low
- **Description**: `(err as NodeJS.ErrnoException).code !== "EEXIST"` assumes the caught value is a Node.js error. If a non-Error value is thrown, accessing `.code` on it may return `undefined`, which would cause the error to be re-thrown. While the behavior is correct in this case, the cast is fragile.
- **Recommendation**: Use a type guard: `err instanceof Error && 'code' in err && err.code === 'EEXIST'`.

### Issue 14: `Kv.get<T>` returns `JSON.parse` result cast to generic `T` without validation
- **File**: `packages/aai/kv.ts:188`
- **Severity**: Medium
- **Description**: `JSON.parse(entry.raw) as T` -- the generic type parameter `T` in `get<T>()` is purely cosmetic. `JSON.parse` returns `any`, and the `as T` cast provides no runtime guarantees. If the stored value does not match `T`, callers will receive data of the wrong shape with no error. The same pattern exists at line 225 in `list<T>()`.
- **Recommendation**: Document that `T` is a trust-based cast (not validated), or provide an overload that accepts a Zod schema for runtime validation. This is a known pattern in TypeScript but should be explicitly documented as unsafe.

### Issue 15: `withSpan` return type loses promise information via `as T` cast
- **File**: `packages/aai/telemetry.ts:111`
- **Severity**: Low
- **Description**: In the `withSpan` function, when `result instanceof Promise` is true, the `.then()/.catch()` chain returns a new `Promise`, which is cast back `as T`. This works at runtime but the type system cannot verify that the promise-wrapped value matches `T`. If `fn` returns a non-Promise value that happens to have a `.then` method (thenable), the type would be incorrect.
- **Recommendation**: Use an overload signature to distinguish sync and async cases: `withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T>` and `withSpan<T>(name: string, fn: (span: Span) => T): T`.
