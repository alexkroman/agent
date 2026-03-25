// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { createTestKvStore, createTestScopeKey, createTestStore } from "./_test-utils.ts";
import { createOrchestrator } from "./orchestrator.ts";

test("orchestrator adds Cross-Origin-Isolation headers", async () => {
  const store = createTestStore();
  const scopeKey = await createTestScopeKey();
  const kvStore = createTestKvStore();
  const app = createOrchestrator({ slots: new Map(), store, scopeKey, kvStore });
  const res = await app.fetch(new Request("http://localhost/health"));
  expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
});

test("orchestrator returns 401 on deploy without auth", async () => {
  const store = createTestStore();
  const scopeKey = await createTestScopeKey();
  const kvStore = createTestKvStore();
  const app = createOrchestrator({ slots: new Map(), store, scopeKey, kvStore });
  const res = await app.fetch(new Request("http://localhost/my-agent/deploy", { method: "POST" }));
  expect(res.status).toBe(401);
});
