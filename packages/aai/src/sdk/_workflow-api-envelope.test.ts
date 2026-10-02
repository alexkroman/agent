// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { freezeDate } from "../host/_test-utils.ts";
import {
  apiFailure,
  apiRoot,
  failureStatus,
  pendingRun,
  readApiJson,
  WORKFLOW_API_ERROR_LABEL,
} from "./_workflow-api-envelope.ts";

describe("apiRoot", () => {
  test("joins the prefix RELATIVELY, keeping a deployed agent's own path", () => {
    expect(apiRoot("https://platform.example/some-slug")).toBe(
      "https://platform.example/some-slug/workflows",
    );
    expect(apiRoot("https://platform.example/some-slug/")).toBe(
      "https://platform.example/some-slug/workflows",
    );
  });

  test("works for an agent served at the origin root", () => {
    expect(apiRoot("http://localhost:3000")).toBe("http://localhost:3000/workflows");
  });
});

describe("apiFailure / failureStatus", () => {
  test("an API failure carries the status, and the agent's own sentence", async () => {
    const err = await apiFailure(Response.json({ error: "no such run" }, { status: 404 }));
    expect(err.status).toBe(404);
    expect(err.message).toContain("no such run");
    expect(failureStatus(err)).toBe(404);
  });

  test("failureStatus answers undefined for anything without a numeric status", () => {
    expect(failureStatus(new Error("x"))).toBeUndefined();
    expect(failureStatus({ status: "404" })).toBeUndefined();
    expect(failureStatus(undefined)).toBeUndefined();
  });
});

describe("readApiJson", () => {
  test("parses a JSON body", async () => {
    await expect(readApiJson(Response.json({ runId: "wrun_1" }))).resolves.toEqual({
      runId: "wrun_1",
    });
  });

  test("names the surface and a preview for a body that is not JSON", async () => {
    await expect(
      readApiJson(new Response("<html>gateway</html>", { status: 200 })),
    ).rejects.toThrow(`${WORKFLOW_API_ERROR_LABEL} 200: <html>gateway</html>`);
  });
});

describe("pendingRun", () => {
  test("is the snapshot of a run the agent accepted but has not reported", () => {
    const now = freezeDate();
    expect(pendingRun("wrun_1", "digest")).toEqual({
      runId: "wrun_1",
      workflow: "digest",
      createdAt: now,
      status: "pending",
    });
  });
});
