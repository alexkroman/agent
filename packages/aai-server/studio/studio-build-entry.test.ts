// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { runBuildRequest } from "./studio-build-entry.ts";
import type { StudioBuildRequest, StudioBuildResult } from "./studio-build-protocol.ts";
import { StudioBuildError } from "./studio-errors.ts";

const REQ: StudioBuildRequest = {
  files: { "agent.ts": "export default {};" },
  worker: true,
  client: false,
};

describe("runBuildRequest", () => {
  test("passes the parsed request to the executor and wraps the result", async () => {
    const seen: StudioBuildRequest[] = [];
    const exec = async (req: StudioBuildRequest): Promise<StudioBuildResult> => {
      seen.push(req);
      return { worker: "bundled" };
    };
    await expect(runBuildRequest(REQ, exec)).resolves.toEqual({ ok: true, worker: "bundled" });
    expect(seen).toEqual([REQ]);
  });

  test("classifies StudioBuildError as a build failure the agent can act on", async () => {
    const exec = async (): Promise<StudioBuildResult> => {
      throw new StudioBuildError("Build failed:\nagent.ts:1: oops");
    };
    await expect(runBuildRequest(REQ, exec)).resolves.toEqual({
      ok: false,
      kind: "build",
      error: "Build failed:\nagent.ts:1: oops",
    });
  });

  test("classifies anything else as internal", async () => {
    const exec = async (): Promise<StudioBuildResult> => {
      throw new Error("ENOSPC");
    };
    await expect(runBuildRequest(REQ, exec)).resolves.toEqual({
      ok: false,
      kind: "internal",
      error: "ENOSPC",
    });
  });

  test("rejects a malformed request without running the executor", async () => {
    let ran = false;
    const exec = async (): Promise<StudioBuildResult> => {
      ran = true;
      return {};
    };
    await expect(runBuildRequest({ files: "nope" }, exec)).resolves.toEqual({
      ok: false,
      kind: "internal",
      error: "Malformed build request",
    });
    expect(ran).toBe(false);
  });
});
