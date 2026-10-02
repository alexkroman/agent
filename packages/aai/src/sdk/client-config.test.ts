// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { buildClientConfig, ClientConfigResponseSchema } from "./client-config.ts";
import { MAX_TRANSCRIPT_CHARS } from "./constants.ts";

describe("buildClientConfig", () => {
  test("defaults the page to voice and writes no key for an unset field", () => {
    const config = buildClientConfig({ name: "a" });
    expect(config).toEqual({ name: "a", page: "voice" });
    // The body crosses JSON, where a present-but-undefined key is a phantom.
    expect(Object.keys(config).sort()).toEqual(["name", "page"]);
  });

  test("carries every field it was given", () => {
    const source = {
      name: "a",
      greeting: "hi",
      sessionUrl: "wss://agents.example/a/session",
      page: "static" as const,
      sessionToken: "t",
    };
    expect(buildClientConfig(source)).toEqual(source);
  });

  test("what it builds is what the schema parses", () => {
    const config = buildClientConfig({ greeting: "hi", sessionToken: "t" });
    expect(ClientConfigResponseSchema.parse(config)).toEqual(config);
  });
});

describe("ClientConfigResponseSchema", () => {
  test("requires a known page", () => {
    expect(ClientConfigResponseSchema.safeParse({}).success).toBe(false);
    expect(ClientConfigResponseSchema.safeParse({ page: "kiosk" }).success).toBe(false);
  });

  test("caps the greeting at the transcript cap", () => {
    const greeting = "x".repeat(MAX_TRANSCRIPT_CHARS + 1);
    expect(ClientConfigResponseSchema.safeParse({ page: "voice", greeting }).success).toBe(false);
  });
});
