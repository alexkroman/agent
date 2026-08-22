// Copyright 2026 the AAI authors. MIT license.
// The npm and download paths BEHIND the validation gate, with the process
// spawn and the SSRF fetch mocked out. The sibling studio-project-tools.test.ts
// covers the gates themselves with the real collaborators; this file covers
// what each tool does with a success, a failure, a kill, and a bad body.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDef } from "@alexkroman1/aai";
import { safeFetch } from "@alexkroman1/aai-runtime/internal";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { npmResult, runTool, useTempDir } from "./_test-utils.ts";
import { MAX_STUDIO_FILE_BYTES } from "./limits.ts";
import { createDesignInspirationTool, createProjectTools } from "./studio-project-tools.ts";
import { runNpm } from "./studio-spawn.ts";

vi.mock("./studio-spawn.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./studio-spawn.ts")>();
  return { ...mod, runNpm: vi.fn() };
});

vi.mock("@alexkroman1/aai-runtime/internal", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@alexkroman1/aai-runtime/internal")>();
  return { ...mod, safeFetch: vi.fn() };
});

const runNpmMock = vi.mocked(runNpm);
const safeFetchMock = vi.mocked(safeFetch);

const tempDir = useTempDir("studio-project-tools-mocked-");
let dir: string;
let tools: Record<string, ToolDef>;

beforeEach(() => {
  dir = tempDir();
  tools = createProjectTools({ dir });
});

const execute = (name: string, args: Record<string, unknown>): Promise<string> =>
  runTool(tools, name, args);

describe("add_dependency / remove_dependency (spawn mocked)", () => {
  test("a clean install reports success with npm's output", async () => {
    runNpmMock.mockResolvedValue(npmResult({ stdout: "added 1 package\n" }));

    const result = await execute("add_dependency", { package: "date-fns" });

    expect(result).toBe("npm install date-fns succeeded\nadded 1 package");
    // The standing flag tail and option bag are runNpm's contract, asserted
    // once in studio-spawn.test.ts; what this tool owns is the verb and spec.
    expect(runNpmMock).toHaveBeenCalledWith(dir, ["install", "date-fns"]);
  });

  test("a clean install with no output stays a bare success line", async () => {
    runNpmMock.mockResolvedValue(npmResult());
    expect(await execute("remove_dependency", { package: "date-fns" })).toBe(
      "npm uninstall date-fns succeeded",
    );
  });

  test("a nonzero exit reports the code and npm's tail", async () => {
    runNpmMock.mockResolvedValue(npmResult({ exitCode: 1, stdout: "E404 not found\n" }));

    const result = await execute("add_dependency", { package: "no-such-pkg" });

    expect(result).toBe("npm install no-such-pkg failed [exit code 1]\nE404 not found");
  });

  test("a nonzero exit with no output says so", async () => {
    runNpmMock.mockResolvedValue(npmResult({ exitCode: 7 }));
    expect(await execute("add_dependency", { package: "quiet-pkg" })).toContain("(no output)");
  });

  test("a timeout kill is annotated with the signal", async () => {
    runNpmMock.mockResolvedValue(
      npmResult({ exitCode: null, signal: "SIGTERM", stdout: "partial" }),
    );

    const result = await execute("add_dependency", { package: "slow-pkg" });

    expect(result).toContain("[killed by SIGTERM");
    expect(result).toContain("partial");
  });

  test("a spawn failure surfaces as an error string, not a throw", async () => {
    runNpmMock.mockRejectedValue(new Error("spawn npm ENOENT"));
    expect(await execute("add_dependency", { package: "x" })).toBe("Error: spawn npm ENOENT");
  });
});

describe("update_dependencies (spawn mocked)", () => {
  // These assert on WHETHER and WITH WHAT npm was spawned, so the shared mock
  // must not carry calls in from a sibling test.
  beforeEach(() => {
    runNpmMock.mockReset();
  });

  const manifest = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
    writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "w", dependencies: deps, devDependencies: dev }, null, 2),
    );

  /** Stand in for npm: succeed, and rewrite the manifest the way it would. */
  const installsTo = (after: Record<string, string>, stdout = "changed 2 packages\n") =>
    runNpmMock.mockImplementation(async () => {
      await manifest(after);
      return npmResult({ stdout });
    });

  test("with no names, bumps every declared package and diffs the manifest", async () => {
    await manifest({ "date-fns": "^2.0.0", zod: "4.1.0" }, { "fake-timers": "^1.0.0" });
    installsTo({ "date-fns": "^4.1.0", zod: "4.1.0", "fake-timers": "^1.0.0" });

    const result = await execute("update_dependencies", {});

    // One invocation for the whole set, each name pinned to @latest by us.
    expect(runNpmMock).toHaveBeenCalledTimes(1);
    expect(runNpmMock.mock.calls[0]?.[1]).toEqual([
      "install",
      "fake-timers@latest",
      "date-fns@latest",
    ]);
    expect(result).toContain("date-fns: ^2.0.0 → ^4.1.0");
    expect(result).toContain("fake-timers: ^1.0.0 (unchanged — already latest)");
    // zod is the toolchain's to version, so it is neither installed nor diffed.
    expect(result).toContain("Left pinned");
    expect(result).toContain("zod");
    expect(result).not.toContain("zod: ");
  });

  test("updates only the named packages", async () => {
    await manifest({ "date-fns": "^2.0.0", nanoid: "^3.0.0" });
    installsTo({ "date-fns": "^4.1.0", nanoid: "^3.0.0" });

    const result = await execute("update_dependencies", { packages: ["date-fns"] });

    expect(runNpmMock.mock.calls[0]?.[1]).toEqual(["install", "date-fns@latest"]);
    expect(result).toContain("date-fns: ^2.0.0 → ^4.1.0");
    expect(result).not.toContain("nanoid");
  });

  test("a package that is not declared is named, and does not get installed", async () => {
    await manifest({ "date-fns": "^2.0.0" });
    installsTo({ "date-fns": "^4.1.0" });

    const result = await execute("update_dependencies", {
      packages: ["date-fns", "never-installed"],
    });

    expect(runNpmMock.mock.calls[0]?.[1]).not.toContain("never-installed@latest");
    expect(result).toContain("use add_dependency to install: never-installed");
  });

  test("a request for only toolchain-owned packages updates nothing", async () => {
    await manifest({ "@alexkroman1/aai": "1.2.3", react: "19.0.0" });

    const result = await execute("update_dependencies", {
      packages: ["@alexkroman1/aai", "react"],
    });

    // Bumping these shadows the baked toolchain with an untested build, and
    // the next ensureProjectShape reconcile would revert the pins anyway.
    expect(runNpmMock).not.toHaveBeenCalled();
    expect(result).toContain("No dependencies to update.");
    expect(result).toContain("Left pinned");
  });

  test("a failed install reports npm's tail and claims no updates", async () => {
    await manifest({ "date-fns": "^2.0.0" });
    runNpmMock.mockResolvedValue(npmResult({ exitCode: 1, stdout: "ERESOLVE conflict\n" }));

    const result = await execute("update_dependencies", {});

    expect(result).toContain("nothing was updated");
    expect(result).toContain("ERESOLVE conflict");
    expect(result).not.toContain("Updated to the registry's latest");
  });

  test("a failure that still rewrote the manifest reports what changed", async () => {
    // npm aborts a resolution conflict before writing, but a postinstall
    // script fails AFTER — claiming nothing changed there sends the agent
    // looking for a version it already has.
    await manifest({ "date-fns": "^2.0.0" });
    runNpmMock.mockImplementation(async () => {
      await manifest({ "date-fns": "^4.1.0" });
      return npmResult({ exitCode: 1, stdout: "postinstall failed\n" });
    });

    const result = await execute("update_dependencies", {});

    expect(result).toContain("npm install failed [exit code 1], but package.json changed:");
    expect(result).toContain("date-fns: ^2.0.0 → ^4.1.0");
    expect(result).toContain("postinstall failed");
  });

  test("an unparseable manifest is refused rather than reified by npm", async () => {
    await writeFile(path.join(dir, "package.json"), "{ not json");

    const result = await execute("update_dependencies", {});

    expect(runNpmMock).not.toHaveBeenCalled();
    expect(result).toContain("not valid JSON");
  });

  test("a spawn failure surfaces as an error string", async () => {
    await manifest({ "date-fns": "^2.0.0" });
    runNpmMock.mockRejectedValue(new Error("spawn npm ENOENT"));
    expect(await execute("update_dependencies", {})).toBe("Error: spawn npm ENOENT");
  });
});

describe("npm_info (spawn mocked)", () => {
  test("returns the registry fields npm printed", async () => {
    runNpmMock.mockResolvedValue(npmResult({ stdout: "name = 'zod'\nversion = '4.0.0'\n" }));

    const result = await execute("npm_info", { package: "zod" });

    expect(result).toBe("name = 'zod'\nversion = '4.0.0'");
    expect(runNpmMock).toHaveBeenCalledWith(
      dir,
      expect.arrayContaining(["view", "zod", "name", "version", "peerDependencies"]),
    );
  });

  test("an empty answer names the package rather than returning nothing", async () => {
    runNpmMock.mockResolvedValue(npmResult());
    expect(await execute("npm_info", { package: "ghost" })).toBe("No registry metadata for ghost");
  });

  test("a nonzero exit reports the code and output", async () => {
    runNpmMock.mockResolvedValue(npmResult({ exitCode: 1, stdout: "E404\n" }));
    expect(await execute("npm_info", { package: "ghost" })).toBe(
      "npm view ghost failed [exit code 1]\nE404",
    );
  });

  test("a spawn failure surfaces as an error string", async () => {
    runNpmMock.mockRejectedValue(new Error("boom"));
    expect(await execute("npm_info", { package: "zod" })).toBe("Error: boom");
  });
});

describe("download_to_workspace (fetch mocked)", () => {
  // `restoreMocks` restores `vi.spyOn` mocks; it does not clear a `vi.fn()`'s
  // call history, so a "was never fetched" assertion would otherwise be
  // satisfied — or falsified — by an earlier test in this file.
  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  // The sibling asserts that a path escape is REFUSED; what it cannot see is
  // the ordering its own test name claims. Swapping the two blocks in
  // `downloadToWorkspace` would still refuse and still produce this string —
  // after issuing a model-controlled outbound request.
  test("a path escape is refused BEFORE the model-controlled URL is fetched", async () => {
    safeFetchMock.mockResolvedValue(new Response("should never be fetched", { status: 200 }));

    const result = await execute("download_to_workspace", {
      url: "https://example.com/data.json",
      path: "../outside.json",
    });

    expect(result).toContain("escapes the workspace");
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

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

describe("generate_design_inspiration", () => {
  test("returns the brief ctx.generate produced, folding context into the prompt", async () => {
    // The tool reaches the model through `ctx.generate` now — the SDK's
    // one-shot generation capability, resolved from the agent's own `llm` —
    // rather than through a `LanguageModel` threaded in beside it.
    const calls: { system: string | undefined; prompt: string }[] = [];
    const result = await runTool(
      createDesignInspirationTool(),
      "generate_design_inspiration",
      { goal: "pizza ordering agent", context: "cozy, red accents" },
      {
        generate: (options) => {
          calls.push({ system: options.system, prompt: options.prompt });
          return Promise.resolve({ text: "Direction: warm and boutique." });
        },
      },
    );

    expect(result).toBe("Direction: warm and boutique.");
    expect(calls[0]?.prompt).toContain("Goal: pizza ordering agent");
    expect(calls[0]?.prompt).toContain("Context: cozy, red accents");
    // The brief's own house style rides on the system prompt, not the goal.
    expect(calls[0]?.system).toContain("design");
  });
});
