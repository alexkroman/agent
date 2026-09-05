// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `tracing`.
 *
 * OTLP span export — the env gate that decides whether any of it happens, the
 * two standard variables it reads, the service name it falls back to, and the
 * handle a caller flushes or shuts down.
 *
 * This capability is unusual in that almost nobody CALLS it: the surface an
 * operator uses is `OTEL_EXPORTER_OTLP_ENDPOINT` in their environment, and the
 * three front doors (`aai start`, `aai dev`, the guest harness) each call
 * `startTracingDetached` once at boot on their behalf. What is versioned here
 * is therefore mostly a contract with a SELF-HOSTER who embeds
 * `createRuntimeServer` in a process of their own and wants spans out of it —
 * they are the ones who call `startTracing` directly and hold its handle.
 *
 * The adoption seam (`adoptRequestTrace`, `setRequestTraceAdopter`) is
 * deliberately absent: it is tagged `@internal` and lives in
 * `_request-trace.ts`, which imports nothing at all so the worker bundle cannot
 * reach the OpenTelemetry graph through it.
 *
 * Re-exported from `@alexkroman1/aai-runtime/tracing`. This file is not shipped
 * and nothing imports it — it exists so `pnpm check:api-contracts` can extract
 * a report for this capability alone, hash it, and hold it to a committed
 * epoch. See `scripts/api-contracts.mjs`.
 */

export {
  DEFAULT_SERVICE_NAME,
  OTEL_ENDPOINT_ENVS,
  OTEL_SERVICE_NAME_ENV,
  type RuntimeTracing,
  startTracing,
  startTracingDetached,
  tracingEndpoint,
} from "../../tracing.ts";
