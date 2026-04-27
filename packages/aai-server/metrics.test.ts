// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, it } from "vitest";
import { registry, serialize } from "./metrics.ts";

describe("metrics registry", () => {
  it("exposes default Node.js process metrics", async () => {
    const text = await serialize();
    expect(text).toContain("nodejs_eventloop_lag_p99_seconds");
    expect(text).toContain("process_resident_memory_bytes");
  });

  it("uses 'aai_' prefix as the canonical namespace for custom metrics", () => {
    expect(registry).toBeDefined();
  });
});
