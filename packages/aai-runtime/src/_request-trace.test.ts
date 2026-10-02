// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the adoption seam, and for the property it exists to protect.
 *
 * The load-bearing one is `imports nothing that reaches OpenTelemetry`: this
 * module is in `createServerForRuntime`'s graph, which `aai build` inlines into
 * the worker with no `node_modules` behind it, so a static OTel import here is
 * a build failure in every scaffolded project that has not installed the
 * optional peers. That is not hypothetical — it is what six e2e specs caught
 * when this code lived in `tracing.ts`, and a source-level assertion is the
 * cheap version of the same alarm.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { adoptRequestTrace, setRequestTraceAdopter } from "./_request-trace.ts";

describe("the adoption seam", () => {
  test("is inert until an adopter is installed", () => {
    setRequestTraceAdopter(undefined);
    expect(() => adoptRequestTrace({ traceparent: "anything" })).not.toThrow();
  });

  test("hands the installed adopter the request's headers verbatim", () => {
    const seen: unknown[] = [];
    setRequestTraceAdopter((headers) => seen.push(headers));
    try {
      adoptRequestTrace({ traceparent: "00-a-b-01", "x-other": ["one", "two"] });
      expect(seen).toEqual([{ traceparent: "00-a-b-01", "x-other": ["one", "two"] }]);
    } finally {
      setRequestTraceAdopter(undefined);
    }
  });

  test("uninstalling stops delivery, so a shut-down tracer holds nothing open", () => {
    const adopter = vi.fn();
    setRequestTraceAdopter(adopter);
    adoptRequestTrace({});
    setRequestTraceAdopter(undefined);
    adoptRequestTrace({});
    expect(adopter).toHaveBeenCalledTimes(1);
  });
});

describe("the bundling constraint", () => {
  test("imports nothing that reaches OpenTelemetry", () => {
    const source = readFileSync(new URL("./_request-trace.ts", import.meta.url), "utf-8");
    // Import STATEMENTS only: the module doc names the packages in prose, and
    // that is the whole point of the file.
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual([]);
  });

  test("the server takes the adopter from HERE, not from the tracing gate", () => {
    const server = readFileSync(new URL("./server/server.ts", import.meta.url), "utf-8");
    expect(server).toContain('import { adoptRequestTrace } from "../_request-trace.ts"');
    // `tracing.ts` carries the dynamic import of the OTel graph. The worker's
    // module graph must not reach it, which is this module's reason to exist.
    expect(server).not.toContain('from "../tracing.ts"');
  });
});
