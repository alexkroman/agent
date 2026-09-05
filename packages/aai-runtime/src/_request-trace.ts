// Copyright 2026 the AAI authors. MIT license.
/**
 * The request-scoped trace adoption seam, and NOTHING that can reach
 * OpenTelemetry.
 *
 * ## Why this is its own module
 *
 * `createRuntimeServer` calls {@link adoptRequestTrace} at the top of every
 * request. If that function lived in `tracing.ts` — beside the env gate and its
 * dynamic `import("./_tracing-otel.ts")` — then `server.ts` would put the OTel
 * graph in the WORKER's module graph, and the worker is bundled by `aai build`
 * with `ssr: { noExternal: true }` and `codeSplitting: false`, because the guest
 * sandbox has no `node_modules` and the worker is delivered as one ESM string.
 * Inlining a dynamic import is exactly what that config does, so
 * `_tracing-otel.ts`'s STATIC `import { ROOT_CONTEXT, SpanKind, … } from
 * "@opentelemetry/api"` had to resolve at build time — against an optional peer
 * a scaffolded project has not installed. Vite stubs that as
 * `__vite-optional-peer-dep:@opentelemetry/api`, which exports nothing, and
 * every named import became a `MISSING_EXPORT` build failure. The e2e suite
 * caught it: six specs, including `npm start` on a scaffolded project.
 *
 * Note what would NOT have fixed it: `@ai-sdk/mcp` survives the same bundle
 * because `mcp-connect.ts` reads a PROPERTY off the namespace
 * (`(await import(…)).createMCPClient`), so there are no named bindings for
 * rolldown to check against the stub. Writing the OTel imports that way would
 * hide the failure rather than remove it.
 *
 * ## The worker does not start tracing, and does not need to
 *
 * Only a HOST process does: `aai start`, `aai dev`, and the guest harness — all
 * of which have real `node_modules` and can resolve the optional peers. The
 * worker still gets its model calls traced, because `registerTelemetry` pushes
 * onto `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`, which every copy of `ai` in
 * the process reads PER CALL. `tracing.ts`'s module doc carries that argument;
 * this module is what keeps the two graphs apart.
 *
 * @module
 */

/** What `startTracingOtel` installs. Undefined until it runs. @internal */
export type RequestTraceAdopter = (headers: Record<string, string | string[] | undefined>) => void;

let adopter: RequestTraceAdopter | undefined;

/**
 * Adopt an inbound request's `traceparent` as the ambient context, if tracing
 * is on. A no-op otherwise, and that is the point — an unconfigured front door
 * pays one undefined check per request.
 *
 * ## Why a function POINTER rather than an import
 *
 * Extraction needs `@opentelemetry/api`, which this module may not have (see
 * above). So the OTel module hands its adopter back on its handle,
 * `startTracing` installs it here, and until then this is inert.
 *
 * ## Why `enterWith` and not `with`
 *
 * The installed implementation uses `AsyncLocalStorage.enterWith`, because the
 * seam it serves has nothing to wrap: this is called from a request handler
 * that RETURNS before the work it started finishes — `/workflows/*` falls
 * through `createRuntimeServer`'s hook to the runtime's own router.
 * `with(ctx, fn)` needs an `fn` and there is none. Node warns `enterWith` is
 * easy to misuse, and the misuse is calling it somewhere that is not a request
 * boundary — which is why this is one named thing with one caller per surface
 * rather than the context manager itself.
 *
 * @internal
 */
export function adoptRequestTrace(headers: Record<string, string | string[] | undefined>): void {
  adopter?.(headers);
}

/**
 * Install the adopter {@link adoptRequestTrace} delegates to.
 *
 * Called by `startTracing` with the adopter the OTel module RETURNED. The
 * direction matters: `_tracing-otel.ts` may not import `tracing.ts` — that is
 * the cycle its `TracingHandle` doc refuses, and a bundler would take it as
 * licence to hoist the lazy chunk out of the dynamic `import()` the whole
 * design rests on.
 *
 * @internal
 */
export function setRequestTraceAdopter(next: RequestTraceAdopter | undefined): void {
  adopter = next;
}
