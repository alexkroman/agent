// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  AgentMetadataSchema,
  DeployBodySchema,
  EnvSchema,
  VectorRequestSchema,
} from "./_schemas.ts";

describe("DeployBodySchema", () => {
  test("accepts valid deploy body", () => {
    const result = DeployBodySchema.safeParse({
      env: { ASSEMBLYAI_API_KEY: "test" },
      worker: "code",
      clientFiles: { "index.html": "<html></html>" },
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty worker", () => {
    const result = DeployBodySchema.safeParse({
      env: {},
      worker: "",
      clientFiles: { "index.html": "<html></html>" },
    });
    expect(result.success).toBe(false);
  });
});

describe("EnvSchema", () => {
  test("accepts valid env", () => {
    expect(EnvSchema.safeParse({ ASSEMBLYAI_API_KEY: "key123" }).success).toBe(true);
  });

  test("rejects empty ASSEMBLYAI_API_KEY", () => {
    expect(EnvSchema.safeParse({ ASSEMBLYAI_API_KEY: "" }).success).toBe(false);
  });

  test("allows extra keys via passthrough", () => {
    expect(EnvSchema.safeParse({ ASSEMBLYAI_API_KEY: "key", CUSTOM: "val" }).success).toBe(true);
  });
});

describe("AgentMetadataSchema", () => {
  test("accepts minimal metadata", () => {
    const result = AgentMetadataSchema.safeParse({ slug: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env).toEqual({});
    }
  });

  test("accepts full metadata", () => {
    const result = AgentMetadataSchema.safeParse({
      slug: "my-agent",
      env: { KEY: "val" },
      credential_hashes: ["abc123"],
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing slug", () => {
    expect(AgentMetadataSchema.safeParse({ env: {} }).success).toBe(false);
  });
});

describe("VectorRequestSchema", () => {
  test("accepts query with valid filter", () => {
    const result = VectorRequestSchema.safeParse({
      op: "query",
      text: "hello",
      filter: 'category = "news"',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ op: "query", filter: 'category = "news"' });
    }
  });

  test("accepts query without filter", () => {
    const result = VectorRequestSchema.safeParse({ op: "query", text: "hello" });
    expect(result.success).toBe(true);
  });

  test("rejects query with dangerous filter", () => {
    expect(() =>
      VectorRequestSchema.parse({
        op: "query",
        text: "hello",
        filter: "id = (SELECT id FROM other)",
      }),
    ).toThrow("disallowed SQL keyword");
  });
});
