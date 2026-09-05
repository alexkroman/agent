// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the env gate — the half of span export that decides whether any of
 * it happens.
 *
 * The claims here are all about what does NOT get built. Unconfigured, nothing
 * is constructed: no provider, no exporter, no integration, no import of the
 * OTel graph at all — which is what lets this module sit in `dist/harness.mjs`
 * on every sandbox's cold-start path, and what makes the OTel packages
 * affordable as optional peers. `startTracingOtel` is deliberately NOT reached
 * from here; `_tracing-otel.test.ts` beside it owns the spans themselves.
 *
 * `registerTelemetry` pushes onto a PROCESS-GLOBAL registry with no unregister,
 * so every case that arms anything tears it down through `onTestFinished`.
 */

import { trace } from "@opentelemetry/api";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  OTEL_ENDPOINT_ENVS,
  startTracing,
  startTracingDetached,
  tracingEndpoint,
} from "./tracing.ts";

/** Yield long enough for a settled dynamic import's continuations to run. */
const flushMicrotasks = (): Promise<void> => Promise.resolve();

/** The AI SDK's registry, which has no unregister of its own. */
type TelemetryGlobal = { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] | undefined };

function clearTelemetryRegistry(): void {
  (globalThis as TelemetryGlobal).AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
}

function registeredIntegrations(): unknown[] | undefined {
  return (globalThis as TelemetryGlobal).AI_SDK_TELEMETRY_INTEGRATIONS;
}

describe("the env gate", () => {
  test("is closed with no collector configured", () => {
    expect(tracingEndpoint({})).toBeUndefined();
  });

  test.each(OTEL_ENDPOINT_ENVS)("opens on the standard variable %s", (name) => {
    expect(tracingEndpoint({ [name]: "http://c:4318" })).toBe("http://c:4318");
  });

  test("treats a blank variable as unset", () => {
    expect(tracingEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " })).toBeUndefined();
  });

  test("unconfigured registers NOTHING — no integration, no provider", async () => {
    clearTelemetryRegistry();
    onTestFinished(clearTelemetryRegistry);
    await expect(startTracing({})).resolves.toBeUndefined();
    // The SDK's own cost is zero while this is empty: it reads the registry per
    // call and runs straight through when there is nothing in it.
    expect(registeredIntegrations()).toBeUndefined();
  });

  test("the DETACHED start returns synchronously and never rejects", async () => {
    clearTelemetryRegistry();
    onTestFinished(clearTelemetryRegistry);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      // Silenced: the guest's stdout is a tenant-visible ring buffer.
    });
    // An unhandled rejection here would reach `installCrashGuards` and exit the
    // guest at boot — telemetry taking the agent down with it. The failure has
    // to be a log line, so this drives the path that produces one.
    expect(startTracingDetached({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" })).toBe(undefined);
    // Let the dynamic import and the provider construction settle, then tear
    // the globals down — this really did start an exporter.
    await vi.waitFor(() => expect(registeredIntegrations()).toHaveLength(1));
    trace.disable();
    expect(errors).not.toHaveBeenCalled();
  });

  test("a configured start with the peers absent names the install line", async () => {
    // The optional-peer path a self-hoster really takes: a collector set, the
    // exporter never installed. Simulated by failing the dynamic import, since
    // this workspace HAS the peers — what is asserted is the message, because a
    // bare ERR_MODULE_NOT_FOUND names an internal chunk the reader never wrote.
    vi.doMock("./_tracing-otel.ts", () => {
      throw new Error("Cannot find package '@opentelemetry/api'");
    });
    onTestFinished(() => {
      vi.doUnmock("./_tracing-otel.ts");
      vi.resetModules();
    });
    vi.resetModules();
    const { startTracing: fresh } = await import("./tracing.ts");
    await expect(fresh({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).rejects.toThrow(
      /optional OpenTelemetry peers[\s\S]*npm i @opentelemetry\/api/,
    );
  });

  test("the detached start does nothing at all when unconfigured", async () => {
    clearTelemetryRegistry();
    onTestFinished(clearTelemetryRegistry);
    expect(startTracingDetached({})).toBe(undefined);
    await flushMicrotasks();
    expect(registeredIntegrations()).toBeUndefined();
  });
});
