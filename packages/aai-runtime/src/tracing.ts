// Copyright 2026 the AAI authors. MIT license.
/**
 * OTLP span export for whatever is running an agent: the ENV GATE, and nothing
 * else.
 *
 * ## One implementation, three front doors
 *
 * This lives in the RUNTIME rather than in the guest harness because the thing
 * that makes the interesting spans — a model call — happens wherever an agent
 * runs, and that is three places with one implementation between them:
 *
 * | Front door | How it arms |
 * | --- | --- |
 * | `aai start` (self-hosting) | the operator's own `process.env` |
 * | `aai dev` | the developer's own `.env` / shell |
 * | a deployed guest | `agentBootEnv` forwards the platform's `OTEL_*` |
 *
 * It used to be `aai-guest/guest-tracing.ts`, which meant the only people who
 * could get a span out of an agent were us — a self-hoster runs
 * `createRuntimeServer` from this package and never loads the harness at all.
 * Moving it here is what makes "point it at your collector" a thing a USER can
 * do, and the platform then runs the same module rather than a second copy.
 *
 * ## The OTel packages are OPTIONAL PEERS, loaded through a dynamic `import()`
 *
 * This module deliberately imports no OpenTelemetry and no `ai`. Everything
 * that does is behind the `import()` in {@link startTracing}, for the reason
 * `mcp-connect.ts` spells out about `@ai-sdk/mcp`: a plain import would put
 * five OTel packages in the tree of every consumer of
 * `@alexkroman1/aai-runtime`, which `artifact-size-report.mjs` fails a new
 * runtime dependency over regardless of bytes. Tracing is opt-in, so the cost
 * belongs to the deployments that opted in.
 *
 * It also keeps the property the guest half was built for: this file ends up in
 * `dist/harness.mjs`, baked into the snapshot image on the cold-start path of
 * every sandbox the platform starts, and an unconfigured guest never evaluates
 * the OTel graph. Measured: 0.1-0.2 ms unconfigured, ~373-404 ms configured.
 *
 * A guest BUNDLES the peers (they are `aai-guest`'s own dependencies, and
 * tsdown inlines them), so the platform never meets the missing-peer path. A
 * self-hoster does, and it is answered with the install line rather than a bare
 * `ERR_MODULE_NOT_FOUND` naming packages they never wrote down.
 *
 * ## Registration IS the enablement
 *
 * The AI SDK emits structured telemetry for model calls, steps and tool calls,
 * armed by `registerTelemetry`. There is no per-call flag to set: measured, a
 * call with no `experimental_telemetry` reports exactly as one with
 * `{ isEnabled: true }`. So the env gate here is the whole switch, and with
 * nothing registered the SDK's own cost is zero — the global is `undefined` and
 * the `ai:telemetry` diagnostics channel reports `hasSubscribers === false`, so
 * a model call runs straight through.
 *
 * **One registration covers every copy of `ai` in the process**, which is the
 * non-obvious part and the reason a deployed guest works at all: it holds two —
 * the harness's and the worker bundle's — and `registerTelemetry` pushes onto
 * `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`, read PER CALL. That is the same
 * property `Symbol.for` buys the workflow run context, and it is why a
 * module-local registry would have covered neither copy reliably. Verified
 * against `ai@7.0.90` by registering after a call had already run and seeing
 * the next one report.
 *
 * ## Where the collector credential lives, on the PLATFORM
 *
 * `OTEL_EXPORTER_OTLP_HEADERS` reaches a deployed guest's `process.env` through
 * `agentBootEnv`, from the platform's own environment. It is therefore not in
 * the agent env surface: `ctx.env` is built from the boot FILE at
 * `AAI_AGENT_ENV_PATH` and `process.env` is never merged into it, so ordinary
 * tool code cannot read it. It is NOT hidden from the sandbox, though — it sits
 * in `process.env` beside `AAI_GUEST_TOKEN`, so agent code that reaches around
 * the SDK for `process.env` directly, or a `run_code` body, can read it. The
 * container is the boundary; that credential shares the sandbox's trust level
 * and must be scoped accordingly (ingest-only, per deployment).
 *
 * A self-hoster owns the whole process, so this is simply their environment and
 * the paragraph above does not apply to them.
 *
 * @module
 */

/** The standard variables that name a collector. Either one arms this. */
export const OTEL_ENDPOINT_ENVS = [
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

/** The standard variable naming this service on every exported span. */
export const OTEL_SERVICE_NAME_ENV = "OTEL_SERVICE_NAME";

/**
 * ## There is NO content-capture switch, deliberately
 *
 * Prompts, completions, transcripts, tool arguments and tool results never
 * leave this process, and there is no variable that changes that. An opt-in was
 * available and the safer answer was too: `_tracing-otel.ts` builds span
 * attributes from an ALLOW-LIST of metadata names, so content is absent because
 * no code path reads it — the safe setting is not the default, it is the only
 * setting.
 *
 * That is worth the lost flexibility because the SDK does not redact for us.
 * Measured against `ai@7.0.90`, every telemetry event carries the conversation
 * (`messages` on the start events; `content`, `text`, `toolCalls`,
 * `toolResults` on the end events), and `recordInputs` / `recordOutputs` are
 * advisory fields passed THROUGH to the integration, defaulting to `true`. An
 * exporter ships to an operator-configured third party, and some deployments
 * carry contractual limits on where transcript data may travel; adding the
 * opt-in later means adding the code that reads those fields, which is exactly
 * the review that should be hard to skip.
 */

/** What a span says it came from when the operator did not say. */
export const DEFAULT_SERVICE_NAME = "aai-agent";

/** A started tracer. */
export type RuntimeTracing = {
  /** Push whatever is buffered. Never rejects. */
  forceFlush: () => Promise<void>;
  /** Flush and release. Never rejects, and is idempotent. */
  shutdown: () => Promise<void>;
};

/**
 * The collector this environment names, or `undefined` for "no tracing".
 *
 * Whitespace-only counts as unset, for the reason `agentBootEnv` omits a blank
 * URL rather than setting one: a key that is present and useless is the shape a
 * misconfiguration takes.
 */
export function tracingEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of OTEL_ENDPOINT_ENVS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Start span export if this environment names a collector; otherwise nothing.
 *
 * **Unconfigured returns before importing anything**, which is the whole reason
 * this is split across two modules: the OTel packages and the `ai` telemetry
 * bridge are reached only through the dynamic `import()` below.
 *
 * AWAITED by the caller when configured, rather than fired and forgotten. An
 * operator who configured a collector has accepted the import cost, and
 * awaiting is what makes the first model call's spans deterministic instead of
 * racing the import; the unconfigured path pays one string read.
 */
export async function startTracing(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeTracing | undefined> {
  if (!tracingEndpoint(env)) return undefined;
  const { startTracingOtel } = await import("./_tracing-otel.ts");
  // The service name is resolved HERE and passed down, so the OTel module
  // imports nothing from this one — see `TracingHandle` there for why a
  // cycle is not merely a lint failure.
  const handle = startTracingOtel(env[OTEL_SERVICE_NAME_ENV]?.trim() || DEFAULT_SERVICE_NAME);
  setRequestTraceAdopter(handle.adoptRequestTrace);
  return handle;
}

/**
 * Adopt an inbound request's `traceparent` as the ambient context, if tracing
 * is on. A no-op otherwise, and that is the point.
 *
 * ## Why a function POINTER rather than an import
 *
 * Extraction needs `@opentelemetry/api`, and this module's whole contract is
 * that it imports no OTel — everything that does sits behind the dynamic
 * `import()` in {@link startTracing}, because this file is in
 * `dist/harness.mjs` on every sandbox's cold-start path. So the OTel module
 * INSTALLS its adopter when it starts, and until then (and forever, on an
 * unconfigured guest) this is one undefined check on a request.
 *
 * ## Why `enterWith` and not `with`
 *
 * The caller is the harness's `request` hook, which returns a boolean and does
 * not wrap the work the request goes on to do — `/workflows/*` falls through it
 * to the runtime's own router. `with(ctx, fn)` needs a function to wrap;
 * `enterWith` sets the context for the remainder of THIS async resource, which
 * is exactly a request's own subtree and nothing else. Node warns it is easy to
 * misuse, and the misuse is calling it somewhere that is not a request
 * boundary — which is why this is exported as one named thing with one caller
 * per surface rather than as the context manager itself.
 */
export function adoptRequestTrace(headers: Record<string, string | string[] | undefined>): void {
  adopter?.(headers);
}

/** What {@link startTracingOtel} installs. Undefined until it runs. */
type RequestTraceAdopter = (headers: Record<string, string | string[] | undefined>) => void;

let adopter: RequestTraceAdopter | undefined;

/**
 * Install the adopter {@link adoptRequestTrace} delegates to.
 *
 * Called by {@link startTracing} with the adopter the OTel module RETURNED.
 *
 * The direction matters: `_tracing-otel.ts` may not import this module —
 * that is the cycle its `TracingHandle` doc refuses, and a bundler would
 * take it as licence to hoist the lazy chunk out of the dynamic `import()` the
 * whole design rests on. So the OTel module hands its adopter back on the
 * handle and this module installs it, exactly as the service name travels the
 * other way.
 */
export function setRequestTraceAdopter(next: RequestTraceAdopter | undefined): void {
  adopter = next;
}

/**
 * Start span export ALONGSIDE the boot rather than in front of it.
 *
 * The harness calls exactly this, and it is a function here rather than three
 * lines there for two reasons. Boot latency is what `harness.ts` is most
 * careful about — `main()` is synchronous, and awaiting the import would put
 * the measured ~390 ms an enabled exporter costs to construct in front of the
 * listen, where an unconfigured guest pays 0.1 ms and a configured one has
 * opted in. And a detached promise needs a `catch` (`guard-invariants` rule 23
 * is the same shape for listeners): without one, a collector URL that will not
 * parse becomes an unhandled rejection, which `installCrashGuards` turns into a
 * guest that exits at boot — telemetry taking the agent down with it.
 *
 * The failure is a LOG LINE and never a throw, for that reason.
 */
export function startTracingDetached(env: NodeJS.ProcessEnv = process.env): void {
  void startTracing(env).catch((err: unknown) => {
    console.error(`tracing start failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
