// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox runtime conformance — integration test.
 *
 * Deploys the shared conformance agent into a real secure-exec V8 isolate
 * and runs the same behavioral tests that the direct executor passes.
 * This ensures both runtimes produce identical observable behavior.
 */

import {
  CONFORMANCE_AGENT_BUNDLE,
  type RuntimeTestContext,
  testRuntime,
} from "@alexkroman1/aai/internal";
import { afterAll, beforeAll } from "vitest";
import { _internals } from "./sandbox.ts";

// ── Setup ──────────────────────────────────────────────────────────────────

const AUTH_TOKEN = "conformance-test-token";

let ctx: RuntimeTestContext;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  // KV store for the sidecar
  const store = new Map<string, unknown>();
  const kv: import("@alexkroman1/aai/kv").Kv = {
    get: (async (key: string) => store.get(key) ?? null) as never,
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: (async () => []) as never,
    keys: async () => [],
  };

  const sidecar = await _internals.startSidecarServer(kv);
  const isolate = await _internals.startIsolate(
    CONFORMANCE_AGENT_BUNDLE,
    sidecar.url,
    // MY_VAR is passed as agent env — the isolate receives it as AAI_ENV_MY_VAR
    { MY_VAR: "test-value" },
    AUTH_TOKEN,
  );

  const isolateUrl = `http://127.0.0.1:${isolate.port}`;
  const executeTool = _internals.buildExecuteTool(isolateUrl, AUTH_TOKEN, isolate.crashed);
  const hookInvoker = _internals.buildHookInvoker(isolateUrl, AUTH_TOKEN, isolate.crashed);

  ctx = { executeTool, hookInvoker };
  cleanup = async () => {
    await isolate.runtime.terminate();
    sidecar.close();
  };
});

afterAll(async () => {
  await cleanup?.();
});

// ── Run shared conformance suite ───────────────────────────────────────────

testRuntime("sandbox", () => ctx);
