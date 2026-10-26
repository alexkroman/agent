// Copyright 2026 the AAI authors. MIT license.
import { createStubWorkflows } from "@alexkroman1/aai/testing";
import type { StartOptions } from "@alexkroman1/aai/workflow-api";
import { describe, expect, test, vi } from "vitest";
import { mapArgument, wrapStart } from "./_client-wrap.ts";

describe("wrapStart", () => {
  test("hands `around` the inner start and the call's arguments, and keeps every other method", async () => {
    const inner = vi.fn(async () => "run_1");
    const client = createStubWorkflows({ start: inner as never });
    const seen: unknown[] = [];
    const wrapped = wrapStart(client, async (start, workflow, input, options) => {
      seen.push(workflow, input, options);
      return await start(workflow, input, { ...options, key: "k" });
    });
    const runId = await wrapped.start("digest", { url: "u" }, {
      notify: false,
    } satisfies StartOptions);
    expect(runId).toBe("run_1");
    expect(seen).toEqual(["digest", { url: "u" }, { notify: false }]);
    expect(inner).toHaveBeenCalledWith("digest", { url: "u" }, { notify: false, key: "k" });
    // The rest of the client is the same object's members, not re-implemented.
    expect(wrapped.get).toBe(client.get);
    expect(wrapped.find).toBe(client.find);
  });
});

describe("mapArgument", () => {
  test("rewrites one positional argument and leaves the others alone", () => {
    const method = vi.fn((workflow: string, key?: string, limit?: number) => [
      workflow,
      key,
      limit,
    ]);
    const scoped = mapArgument(method, 1, (key) => key ?? "session-1");
    expect(scoped("digest", undefined, 3)).toEqual(["digest", "session-1", 3]);
    expect(scoped("digest", "explicit")).toEqual(["digest", "explicit", undefined]);
  });
});
