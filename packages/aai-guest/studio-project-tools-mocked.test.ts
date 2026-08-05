// Copyright 2026 the AAI authors. MIT license.
// The npm and download paths BEHIND the validation gate, with the process
// spawn and the SSRF fetch mocked out. The sibling studio-project-tools.test.ts
// covers the gates themselves with the real collaborators; this file covers
// what each tool does with a success, a failure, a kill, and a bad body.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeFetch } from "@alexkroman1/aai/runtime";
import type { ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_STUDIO_FILE_BYTES } from "./limits.ts";
import { createDesignInspirationTool, createProjectTools } from "./studio-project-tools.ts";
import { runCapped } from "./studio-spawn.ts";

vi.mock("./studio-spawn.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./studio-spawn.ts")>();
  return { ...mod, runCapped: vi.fn() };
});

vi.mock("@alexkroman1/aai/runtime", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@alexkroman1/aai/runtime")>();
  return { ...mod, safeFetch: vi.fn() };
});

const runCappedMock = vi.mocked(runCapped);
const safeFetchMock = vi.mocked(safeFetch);

let dir: string;
let tools: ToolSet;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "studio-project-tools-mocked-"));
  tools = createProjectTools({ dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function execute(name: string, args: unknown): Promise<unknown> {
  const t = tools[name];
  if (!t?.execute) throw new Error(`no such tool: ${name}`);
  return Promise.resolve(t.execute(args as never, {} as never));
}

const npmResult = (over: Partial<Awaited<ReturnType<typeof runCapped>>> = {}) => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  ...over,
});

describe("add_dependency / remove_dependency (spawn mocked)", () => {
  test("a clean install reports success with npm's output", async () => {
    runCappedMock.mockResolvedValue(npmResult({ stdout: "added 1 package\n" }));

    const result = await execute("add_dependency", { package: "date-fns" });

    expect(result).toBe("npm install date-fns succeeded\nadded 1 package");
    expect(runCappedMock).toHaveBeenCalledWith(
      "npm",
      ["install", "date-fns", "--no-audit", "--no-fund", "--loglevel=error"],
      expect.objectContaining({ cwd: dir, combineStreams: true }),
    );
  });

  test("a clean install with no output stays a bare success line", async () => {
    runCappedMock.mockResolvedValue(npmResult());
    expect(await execute("remove_dependency", { package: "date-fns" })).toBe(
      "npm uninstall date-fns succeeded",
    );
  });

  test("a nonzero exit reports the code and npm's tail", async () => {
    runCappedMock.mockResolvedValue(npmResult({ exitCode: 1, stdout: "E404 not found\n" }));

    const result = await execute("add_dependency", { package: "no-such-pkg" });

    expect(result).toBe("npm install no-such-pkg failed [exit code 1]\nE404 not found");
  });

  test("a nonzero exit with no output says so", async () => {
    runCappedMock.mockResolvedValue(npmResult({ exitCode: 7 }));
    expect(await execute("add_dependency", { package: "quiet-pkg" })).toContain("(no output)");
  });

  test("a timeout kill is annotated with the signal", async () => {
    runCappedMock.mockResolvedValue(
      npmResult({ exitCode: null, signal: "SIGTERM", stdout: "partial" }),
    );

    const result = await execute("add_dependency", { package: "slow-pkg" });

    expect(result).toContain("[killed by SIGTERM");
    expect(result).toContain("partial");
  });

  test("a spawn failure surfaces as an error string, not a throw", async () => {
    runCappedMock.mockRejectedValue(new Error("spawn npm ENOENT"));
    expect(await execute("add_dependency", { package: "x" })).toBe("Error: spawn npm ENOENT");
  });
});

describe("npm_info (spawn mocked)", () => {
  test("returns the registry fields npm printed", async () => {
    runCappedMock.mockResolvedValue(npmResult({ stdout: "name = 'zod'\nversion = '4.0.0'\n" }));

    const result = await execute("npm_info", { package: "zod" });

    expect(result).toBe("name = 'zod'\nversion = '4.0.0'");
    expect(runCappedMock).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["view", "zod", "name", "version", "peerDependencies"]),
      expect.objectContaining({ cwd: dir }),
    );
  });

  test("an empty answer names the package rather than returning nothing", async () => {
    runCappedMock.mockResolvedValue(npmResult());
    expect(await execute("npm_info", { package: "ghost" })).toBe("No registry metadata for ghost");
  });

  test("a nonzero exit reports the code and output", async () => {
    runCappedMock.mockResolvedValue(npmResult({ exitCode: 1, stdout: "E404\n" }));
    expect(await execute("npm_info", { package: "ghost" })).toBe(
      "npm view ghost failed [exit code 1]\nE404",
    );
  });

  test("a spawn failure surfaces as an error string", async () => {
    runCappedMock.mockRejectedValue(new Error("boom"));
    expect(await execute("npm_info", { package: "zod" })).toBe("Error: boom");
  });
});

describe("download_to_workspace (fetch mocked)", () => {
  test("writes a utf-8 body into the workspace", async () => {
    safeFetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const result = await execute("download_to_workspace", {
      url: "https://example.com/menu.json",
      path: "data/menu.json",
    });

    expect(result).toBe("Downloaded https://example.com/menu.json to data/menu.json (11 bytes)");
    expect(await readFile(path.join(dir, "data/menu.json"), "utf-8")).toBe('{"ok":true}');
  });

  test("a non-2xx answer is reported with its status, and nothing is written", async () => {
    safeFetchMock.mockResolvedValue(new Response("gone", { status: 404, statusText: "Not Found" }));

    const result = await execute("download_to_workspace", {
      url: "https://example.com/missing.json",
      path: "missing.json",
    });

    expect(result).toBe("Error: https://example.com/missing.json answered 404 Not Found");
    await expect(readFile(path.join(dir, "missing.json"))).rejects.toThrow();
  });

  test("a body over the workspace file cap is refused", async () => {
    safeFetchMock.mockResolvedValue(
      new Response("x".repeat(MAX_STUDIO_FILE_BYTES + 1), { status: 200 }),
    );

    const result = await execute("download_to_workspace", {
      url: "https://example.com/huge.txt",
      path: "huge.txt",
    });

    expect(result).toContain("too large to sync to the project");
    await expect(readFile(path.join(dir, "huge.txt"))).rejects.toThrow();
  });

  test("a binary body is refused with guidance instead of corrupting the sync", async () => {
    // 0xFF 0xFE is not valid utf-8, so the fatal decoder throws.
    safeFetchMock.mockResolvedValue(new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }));

    const result = await execute("download_to_workspace", {
      url: "https://example.com/logo.png",
      path: "logo.png",
    });

    expect(result).toContain("the response is binary");
    expect(result).toContain("by URL in client.tsx");
    await expect(readFile(path.join(dir, "logo.png"))).rejects.toThrow();
  });
});

describe("generate_design_inspiration (model mocked)", () => {
  test("returns the model's brief, folding context into the prompt", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        return {
          content: [{ type: "text", text: "Direction: warm and boutique." }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const designTools = createDesignInspirationTool(model);
    const t = designTools.generate_design_inspiration;

    const result = await t?.execute?.(
      { goal: "pizza ordering agent", context: "cozy, red accents" } as never,
      {} as never,
    );

    expect(result).toBe("Direction: warm and boutique.");
    expect(JSON.stringify(prompts)).toContain("Goal: pizza ordering agent");
    expect(JSON.stringify(prompts)).toContain("Context: cozy, red accents");
  });
});
