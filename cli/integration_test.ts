// Copyright 2025 the AAI authors. MIT license.
/**
 * CLI integration tests.
 *
 * Test CLI subcommands end-to-end: init creates working projects,
 * deploy sends correct requests, and the CLI arg parser works correctly.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { CommanderError } from "commander";
import { afterEach, describe, expect, test, vi } from "vitest";
import { _internals, runDeploy } from "./_deploy.ts";
import { fileExists } from "./_discover.ts";
import { listTemplates, runInit } from "./_init.ts";
import { makeBundle, silenced, withTempDir } from "./_test_utils.ts";
import { createProgram } from "./cli.ts";

// --- CLI arg parsing integration ---

function applyTestOverrides(
  cmd: Command,
  output: { writeOut: (str: string) => void; writeErr: (str: string) => void },
) {
  cmd.exitOverride();
  cmd.configureOutput(output);
  for (const sub of cmd.commands) {
    applyTestOverrides(sub, output);
  }
}

function testProgram() {
  let stdout = "";
  let stderr = "";
  const program = createProgram();
  applyTestOverrides(program, {
    writeOut: (str) => {
      stdout += str;
    },
    writeErr: (str) => {
      stderr += str;
    },
  });
  return {
    parse: (args: string[]) => program.parseAsync(args, { from: "user" }),
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("CLI integration: arg parsing", () => {
  test("all subcommands are registered", async () => {
    const t = testProgram();
    await expect(t.parse(["--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    for (const cmd of ["init", "dev", "build", "deploy", "start", "secret", "rag"]) {
      expect(output).toContain(cmd);
    }
  });

  test("deploy subcommand has expected options", async () => {
    const t = testProgram();
    await expect(t.parse(["deploy", "--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("--dry-run");
    expect(output).toContain("--server");
  });

  test("unknown command produces helpful error", async () => {
    const t = testProgram();
    await expect(t.parse(["fakecmd"])).rejects.toThrow(CommanderError);
    expect(t.stderr()).toContain("unknown command");
  });
});

// --- init integration ---

describe("CLI integration: init creates working project", () => {
  async function createFakeTemplates(dir: string): Promise<string> {
    const templatesDir = path.join(dir, "templates");
    const shared = path.join(templatesDir, "_shared");
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, "shared.txt"), "from shared");
    await fs.writeFile(path.join(shared, ".env.example"), "MY_KEY=");
    await fs.writeFile(path.join(shared, "package.json"), '{"name":"test"}');

    const simple = path.join(templatesDir, "simple");
    await fs.mkdir(simple, { recursive: true });
    await fs.writeFile(
      path.join(simple, "agent.ts"),
      'export default defineAgent({\n  name: "Default Name",\n});',
    );
    return templatesDir;
  }

  test("init creates all expected files from template + shared", async () => {
    await withTempDir(
      silenced(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "my-project");
        await runInit({ targetDir: target, template: "simple", templatesDir });

        // agent.ts from template
        expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
        const agentContent = await fs.readFile(path.join(target, "agent.ts"), "utf-8");
        expect(agentContent).toContain("defineAgent");

        // shared.txt from _shared
        expect(await fileExists(path.join(target, "shared.txt"))).toBe(true);

        // .env created from .env.example
        expect(await fileExists(path.join(target, ".env"))).toBe(true);
        expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("MY_KEY=");

        // package.json from _shared
        expect(await fileExists(path.join(target, "package.json"))).toBe(true);
      }),
    );
  });

  test("listTemplates returns only non-underscore directories", async () => {
    await withTempDir(async (dir) => {
      const templatesDir = await createFakeTemplates(dir);
      const templates = await listTemplates(templatesDir);
      expect(templates).toEqual(["simple"]);
      expect(templates).not.toContain("_shared");
    });
  });

  test("init rejects unknown template", async () => {
    await withTempDir(
      silenced(async (dir) => {
        const templatesDir = await createFakeTemplates(dir);
        await expect(
          runInit({ targetDir: path.join(dir, "out"), template: "nope", templatesDir }),
        ).rejects.toThrow("unknown template");
      }),
    );
  });
});

// --- deploy integration ---

describe("CLI integration: deploy flow", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  const deployOpts = (overrides?: Record<string, unknown>) => ({
    url: "http://localhost:3000",
    bundle: makeBundle(),
    env: {},
    slug: "my-agent",
    apiKey: "test-key",
    ...overrides,
  });

  test("deploy sends bundle with correct auth headers", async () => {
    fetchSpy = vi
      .spyOn(_internals, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await runDeploy(deployOpts());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toContain("/my-agent/deploy");
    expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer test-key");
    expect(result.slug).toBe("my-agent");
  });

  test("deploy retries with new slug on 403 ownership conflict", async () => {
    let attempt = 0;
    fetchSpy = vi.spyOn(_internals, "fetch").mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Slug "my-agent" is owned by another' }), {
            status: 403,
          }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    const result = await runDeploy(deployOpts());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(typeof result.slug).toBe("string");
  });

  test("deploy throws on server errors", async () => {
    fetchSpy = vi
      .spyOn(_internals, "fetch")
      .mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(runDeploy(deployOpts())).rejects.toThrow("deploy failed (500)");
  });
});
