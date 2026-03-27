// Copyright 2025 the AAI authors. MIT license.
/**
 * CLI integration tests.
 *
 * Test CLI subcommands end-to-end: init creates working projects,
 * deploy sends correct requests, and the CLI arg parser works correctly.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { renderUsage } from "citty";
import { describe, expect, test, vi } from "vitest";
import { runDeploy } from "./_deploy.ts";
import { fileExists } from "./_discover.ts";
import {
  fakeDownloadAndMerge,
  fakeListTemplates,
  makeBundle,
  silenced,
  withTempDir,
} from "./_test-utils.ts";
import { mainCommand } from "./cli.ts";

// --- CLI arg parsing integration ---

describe("CLI integration: arg parsing", () => {
  test("all subcommands are registered", () => {
    const subs = mainCommand.subCommands as Record<string, unknown>;
    for (const cmd of ["init", "dev", "build", "deploy", "start", "secret", "rag"]) {
      expect(subs[cmd]).toBeDefined();
    }
  });

  test("deploy subcommand has expected options", () => {
    const subs = mainCommand.subCommands as Record<string, { args?: Record<string, unknown> }>;
    const deployCmd = subs.deploy;
    expect(deployCmd?.args?.dryRun).toBeDefined();
    expect(deployCmd?.args?.server).toBeDefined();
  });

  test("usage renders without error", async () => {
    const usage = await renderUsage(mainCommand);
    expect(usage).toContain("aai");
  });
});

// --- init integration ---

let fakeTemplatesDir: string;

vi.mock("./_templates.ts", () => ({
  listTemplates: () => fakeListTemplates(fakeTemplatesDir),
  downloadAndMergeTemplate: (template: string, targetDir: string) =>
    fakeDownloadAndMerge(fakeTemplatesDir, template, targetDir),
}));

const { listTemplates } = await import("./_templates.ts");
const { runInit } = await import("./_init.ts");

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
        fakeTemplatesDir = await createFakeTemplates(dir);
        const target = path.join(dir, "my-project");
        await runInit({ targetDir: target, template: "simple" });

        expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
        const agentContent = await fs.readFile(path.join(target, "agent.ts"), "utf-8");
        expect(agentContent).toContain("defineAgent");
        expect(await fileExists(path.join(target, "shared.txt"))).toBe(true);
        expect(await fileExists(path.join(target, ".env"))).toBe(true);
        expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("MY_KEY=");
        expect(await fileExists(path.join(target, "package.json"))).toBe(true);
      }),
    );
  });

  test("listTemplates returns only non-underscore directories", async () => {
    await withTempDir(async (dir) => {
      fakeTemplatesDir = await createFakeTemplates(dir);
      const templates = await listTemplates();
      expect(templates).toEqual(["simple"]);
      expect(templates).not.toContain("_shared");
    });
  });

  test("init rejects unknown template", async () => {
    await withTempDir(
      silenced(async (dir) => {
        fakeTemplatesDir = await createFakeTemplates(dir);
        await expect(
          runInit({ targetDir: path.join(dir, "out"), template: "nope" }),
        ).rejects.toThrow("unknown template");
      }),
    );
  });
});

// --- deploy integration ---

describe("CLI integration: deploy flow", () => {
  const deployOpts = (fetch: typeof globalThis.fetch, overrides?: Record<string, unknown>) => ({
    url: "http://localhost:3000",
    bundle: makeBundle(),
    env: {},
    slug: "my-agent",
    apiKey: "test-key",
    fetch,
    ...overrides,
  });

  test("deploy sends bundle with correct auth headers", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await runDeploy(deployOpts(mockFetch));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toContain("/my-agent/deploy");
    expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer test-key");
    expect(result.slug).toBe("my-agent");
  });

  test("deploy retries with new slug on 403 ownership conflict", async () => {
    let attempt = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
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
    const result = await runDeploy(deployOpts(mockFetch));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(typeof result.slug).toBe("string");
  });

  test("deploy throws on server errors", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("deploy failed (HTTP 500)");
  });
});
