// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import type { AgentScope } from "./scope-token.ts";
import { importScopeKey, signScopeToken, verifyScopeToken } from "./scope-token.ts";

describe("scope tokens", () => {
  const scope: AgentScope = { keyHash: "abc123", slug: "my-agent" };

  test("round-trips a scope", async () => {
    const key = await importScopeKey("test-secret");
    const token = await signScopeToken(key, scope);
    expect(await verifyScopeToken(key, token)).toEqual(scope);
  });

  test("rejects tampered token", async () => {
    const key = await importScopeKey("test-secret");
    const token = await signScopeToken(key, scope);
    const mid = Math.floor(token.length / 2);
    const tampered = token.slice(0, mid) + (token[mid] === "A" ? "B" : "A") + token.slice(mid + 1);
    expect(await verifyScopeToken(key, tampered)).toBeNull();
  });

  test("rejects garbage", async () => {
    const key = await importScopeKey("test-secret");
    expect(await verifyScopeToken(key, "not-a-token")).toBeNull();
    expect(await verifyScopeToken(key, "")).toBeNull();
  });

  test("different scopes produce different tokens", async () => {
    const key = await importScopeKey("test-secret");
    const other: AgentScope = { keyHash: "abc123", slug: "other-agent" };
    expect(await signScopeToken(key, scope)).not.toBe(await signScopeToken(key, other));
  });

  test("wrong key rejects token", async () => {
    const key1 = await importScopeKey("key-one");
    const key2 = await importScopeKey("key-two");
    const token = await signScopeToken(key1, scope);
    expect(await verifyScopeToken(key2, token)).toBeNull();
  });
});
