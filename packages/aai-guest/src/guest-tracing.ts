// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's span export: the ENV GATE, and nothing else.
 *
 * This module deliberately imports no OpenTelemetry and no `ai`. Everything
 * that does is behind the dynamic `import()` in {@link startGuestTracing}, so a
 * guest with no collector configured never evaluates that module graph — which
 * matters more here than anywhere else in the product, because this file is in
 * `dist/harness.mjs`, baked into the snapshot image, on the cold-start path of
 * every sandbox the platform starts.
 *
 * ## Why the bridge is in the GUEST and not the platform
 *
 * The AI SDK emits structured telemetry for model calls, steps and tool calls,
 * armed by `registerTelemetry`. That arms the process that CALLS the model, and
 * neither platform package makes such a call — `aai-server` and
 * `aai-studio-server` do not depend on `ai` at all. The model calls happen
 * here: the studio coding agent through `studio-agent.ts`, and a deployed
 * agent's voice pipeline through the worker bundle's own `aai-runtime`.
 *
 * **One registration covers both**, which is the non-obvious part. A deployed
 * guest holds two copies of `ai` — the harness's and the bundle's — and
 * `registerTelemetry` pushes onto `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`,
 * read PER CALL. That is the same property `Symbol.for` buys the workflow run
 * context, and it is why a module-local registry would have covered neither
 * copy reliably. Verified against `ai@7.0.90` by registering after a call had
 * already run and seeing the next one report.
 *
 * ## Registration IS the enablement
 *
 * There is no per-call flag to set: measured, a call with no
 * `experimental_telemetry` reports exactly as one with `{ isEnabled: true }`.
 * So the env gate here is the whole switch, and with nothing registered the
 * SDK's own cost is zero — the global is `undefined` and the `ai:telemetry`
 * diagnostics channel reports `hasSubscribers === false`, so a model call runs
 * straight through.
 *
 * ## Where the collector credential lives
 *
 * `OTEL_EXPORTER_OTLP_HEADERS` arrives in the guest's `process.env`, through
 * `agentBootEnv` from the PLATFORM's own environment. It is therefore not in
 * the agent env surface: `ctx.env` is built from the boot FILE at
 * `AAI_AGENT_ENV_PATH` and `process.env` is never merged into it, so ordinary
 * tool code cannot read it. It is NOT hidden from the sandbox, though — it sits
 * in `process.env` beside `AAI_GUEST_TOKEN`, so agent code that reaches around
 * the SDK for `process.env` directly, or a `run_code` body, can read it. The
 * container is the boundary; this credential shares the sandbox's trust level
 * and must be scoped accordingly (ingest-only, per deployment).
 *
 * @module
 */

/** The standard variables that name a collector. Either one arms this. */
export const GUEST_OTEL_ENDPOINT_ENVS = [
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

/** The standard variable naming this service on every exported span. */
export const GUEST_OTEL_SERVICE_NAME_ENV = "OTEL_SERVICE_NAME";

/**
 * ## There is NO content-capture switch, deliberately
 *
 * Prompts, completions, transcripts, tool arguments and tool results never
 * leave this process, and there is no variable that changes that. An opt-in was
 * available and the safer answer was too: `_guest-tracing-otel.ts` builds span
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
export const GUEST_DEFAULT_SERVICE_NAME = "aai-agent-guest";

/** A started guest tracer. */
export type GuestTracing = {
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
export function guestTracingEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of GUEST_OTEL_ENDPOINT_ENVS) {
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
export async function startGuestTracing(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GuestTracing | undefined> {
  if (!guestTracingEndpoint(env)) return undefined;
  const { startGuestTracingOtel } = await import("./_guest-tracing-otel.ts");
  // The service name is resolved HERE and passed down, so the OTel module
  // imports nothing from this one — see `GuestTracingHandle` there for why a
  // cycle is not merely a lint failure.
  return startGuestTracingOtel(
    env[GUEST_OTEL_SERVICE_NAME_ENV]?.trim() || GUEST_DEFAULT_SERVICE_NAME,
  );
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
export function startGuestTracingDetached(env: NodeJS.ProcessEnv = process.env): void {
  void startGuestTracing(env).catch((err: unknown) => {
    console.error(`tracing start failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
