// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import type { StudioBuildRequest } from "./studio-build-protocol.ts";
import {
  createModalBuildRunner,
  createSubprocessBuildRunner,
  resolveStudioBuildRunner,
} from "./studio-build-runner.ts";
import { StudioBuildError } from "./studio-errors.ts";

const REQ: StudioBuildRequest = { files: { "agent.ts": "x" }, worker: true, client: false };

describe("resolveStudioBuildRunner", () => {
  test("defaults to the subprocess backend and memoizes per backend", () => {
    const runner = resolveStudioBuildRunner({});
    expect(resolveStudioBuildRunner({})).toBe(runner);
    expect(resolveStudioBuildRunner({ STUDIO_BUILD_BACKEND: "subprocess" })).toBe(runner);
    const modal = resolveStudioBuildRunner({ STUDIO_BUILD_BACKEND: "modal" });
    expect(modal).not.toBe(runner);
    expect(resolveStudioBuildRunner({ STUDIO_BUILD_BACKEND: "modal" })).toBe(modal);
  });

  test("an unknown backend throws instead of picking a build path", () => {
    expect(() => resolveStudioBuildRunner({ STUDIO_BUILD_BACKEND: "in-process" })).toThrow(
      /Unknown STUDIO_BUILD_BACKEND/,
    );
  });
});

describe("wire handling (via injected invoke)", () => {
  test("round-trips the request and unwraps the result", async () => {
    const invoke = vi.fn(async (json: string) => {
      expect(JSON.parse(json)).toEqual(REQ);
      return JSON.stringify({ ok: true, worker: "bundled" });
    });
    const run = createModalBuildRunner({ invoke });
    await expect(run(REQ)).resolves.toEqual({ worker: "bundled" });
  });

  test("a build-classified failure rethrows as StudioBuildError", async () => {
    const run = createModalBuildRunner({
      invoke: async () =>
        JSON.stringify({ ok: false, kind: "build", error: "Build failed:\nagent.ts:1: oops" }),
    });
    const err = await run(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioBuildError);
    expect((err as Error).message).toContain("oops");
  });

  test("an internal failure is a plain error, never StudioBuildError", async () => {
    const run = createModalBuildRunner({
      invoke: async () => JSON.stringify({ ok: false, kind: "internal", error: "ENOSPC" }),
    });
    const err = await run(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StudioBuildError);
    expect((err as Error).message).toContain("ENOSPC");
  });

  test.each([["not json"], [42], [JSON.stringify({ nope: true })]])(
    "a malformed worker response (%j) is an internal error",
    async (raw) => {
      const run = createModalBuildRunner({ invoke: async () => raw });
      await expect(run(REQ)).rejects.toThrow(/Malformed response/);
    },
  );

  test("times out a hung build worker", async () => {
    const run = createModalBuildRunner({
      invoke: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    await expect(run(REQ)).rejects.toThrow(/timed out/);
  });
});

describe("subprocess backend (real build entry)", () => {
  test("builds a worker bundle out of process", async () => {
    const run = createSubprocessBuildRunner();
    const result = await run({
      files: {
        "agent.ts": `import { agent } from "@alexkroman1/aai";
export default agent({ name: "Subprocess Agent" });`,
      },
      worker: true,
      client: false,
    });
    expect(result.worker).toContain("Subprocess Agent");
    expect(result.clientFiles).toBeUndefined();
  }, 120_000);

  test("returns compile errors as StudioBuildError across the process boundary", async () => {
    const run = createSubprocessBuildRunner();
    const err = await run({
      files: { "agent.ts": "const nope = {" },
      worker: true,
      client: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudioBuildError);
    expect((err as Error).message).toContain("Build failed");
  }, 120_000);
});
