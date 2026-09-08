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
 * **That fix was necessary and not sufficient, and this paragraph used to say
 * the opposite.** It argued that reaching OTel the way `mcp-connect.ts` reaches
 * `@ai-sdk/mcp` — off a namespace the dynamic import hands back, so there are no
 * named bindings for rolldown to check — would "hide the failure rather than
 * remove it". It removes it. The named bindings were the failure: keeping this
 * module's graph out of ONE bundle left the same twelve `[MISSING_EXPORT]`
 * errors waiting for the next caller, and a `vercel deploy` of a scaffolded
 * project found one. `_tracing-otel.ts` now loads all five peers through
 * `loadOtelPeers`, which is what makes the missing-peer path surface where it
 * belongs — when tracing is armed — instead of at a user's build. This module
 * still earns its keep: it keeps the OTel graph out of the WORKER, which is a
 * boot-cost property rather than a build-time one.
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
