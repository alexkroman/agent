// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { previewBody, readJsonBody, statusWithPreview } from "./response-body.ts";

describe("previewBody", () => {
  test("keeps a short body whole", () => {
    expect(previewBody("short")).toBe("short");
  });

  test("cuts a long body at 200 characters and marks the cut", () => {
    const preview = previewBody("x".repeat(500));
    expect(preview).toBe(`${"x".repeat(200)}…`);
  });
});

describe("statusWithPreview", () => {
  test("is the status alone for an empty body", () => {
    expect(statusWithPreview(502, "")).toBe("502");
  });

  test("prefixes a label, and appends a preview of the body", () => {
    expect(statusWithPreview(502, "Bad Gateway", "Workflow API")).toBe(
      "Workflow API 502: Bad Gateway",
    );
  });
});

describe("readJsonBody", () => {
  test("parses a JSON body, including a falsy one", async () => {
    await expect(readJsonBody(Response.json({ a: 1 }), "X")).resolves.toEqual({ a: 1 });
    await expect(readJsonBody(new Response("null"), "X")).resolves.toBeNull();
  });

  test("throws the label, the status and a preview for a body that is not JSON", async () => {
    await expect(readJsonBody(new Response("oops", { status: 500 }), "Agent")).rejects.toThrow(
      "Agent 500: oops",
    );
  });

  test("an empty body is malformed, not an empty value", async () => {
    await expect(readJsonBody(new Response(null, { status: 204 }), "Agent")).rejects.toThrow(
      /^Agent 204$/,
    );
  });
});
