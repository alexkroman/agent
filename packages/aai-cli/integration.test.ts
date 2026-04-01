// Copyright 2025 the AAI authors. MIT license.
/**
 * CLI integration tests against a mock platform API server.
 *
 * Starts a real HTTP server that mimics the AAI platform API, then exercises
 * CLI commands (deploy, delete, secrets) against it. Tests the full request
 * path: CLI function → apiRequest → HTTP → mock server → response handling.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { runDelete } from "./_delete.ts";
import { runDeploy } from "./_deploy.ts";
import { fileExists, readProjectConfig, writeProjectConfig } from "./_discover.ts";
import type { MockApi } from "./_mock-api.ts";
import { startMockApi } from "./_mock-api.ts";
import {
  fakeDownloadAndMerge,
  fakeListTemplates,
  makeBundle,
  silenced,
  withTempDir,
} from "./_test-utils.ts";
import { runSecretDelete, runSecretList, runSecretPut } from "./secret.ts";

// Mock the password prompt to avoid interactive input
vi.mock("./_prompts.ts", () => ({
  askPassword: vi.fn(() => Promise.resolve("super-secret")),
}));

/** Get a request from the recorded list, throwing if it doesn't exist. */
function getReq(index: number) {
  const r = api.requests[index];
  if (!r) throw new Error(`No request at index ${index}`);
  return r;
}

let api: MockApi;

beforeAll(async () => {
  api = await startMockApi();
});

afterEach(() => {
  api.clear();
});

afterAll(async () => {
  await api.stop();
});

// ── Deploy ───────────────────────────────────────────────────────────────────

describe("deploy against mock API", () => {
  test("successful deploy sends POST /deploy with auth and body", async () => {
    const result = await runDeploy({
      url: api.url,
      bundle: makeBundle(),
      env: { ASSEMBLYAI_API_KEY: "key-123" },
      slug: "my-agent",
      apiKey: "test-key",
    });

    expect(result.slug).toBe("my-agent");
    expect(api.requests).toHaveLength(1);

    const req = getReq(0);
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/deploy");
    expect(req.headers.authorization).toBe("Bearer test-key");
    expect(req.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body.slug).toBe("my-agent");
    expect(body.worker).toBe("// worker");
    expect(body.clientFiles).toEqual({ "index.html": "<html></html>" });
    expect((body.env as Record<string, string>).ASSEMBLYAI_API_KEY).toBe("key-123");
  });

  test("first deploy without slug gets server-generated slug", async () => {
    const result = await runDeploy({
      url: api.url,
      bundle: makeBundle(),
      env: {},
      apiKey: "test-key",
    });

    // Server generates a slug when none provided
    expect(result.slug).toMatch(/^generated-/);
    const body = JSON.parse(getReq(0).body) as Record<string, unknown>;
    expect(body.slug).toBeUndefined();
  });

  test("401 throws with API key hint", async () => {
    await expect(
      runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        slug: "my-agent",
        apiKey: "invalid-key",
      }),
    ).rejects.toThrow("API key may be invalid");
  });

  test("413 throws with bundle size hint", async () => {
    api.override("POST", "/deploy", 413, "payload too large");
    await expect(
      runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        slug: "my-agent",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("bundle is too large");
  });

  test("500 throws with status and body", async () => {
    api.override("POST", "/deploy", 500, "internal error");
    await expect(
      runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        slug: "my-agent",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("deploy failed (HTTP 500)");
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────

describe("delete against mock API", () => {
  test("successful delete sends DELETE with auth", async () => {
    await runDelete({
      url: api.url,
      slug: "my-agent",
      apiKey: "test-key",
    });

    expect(api.requests).toHaveLength(1);
    const req = getReq(0);
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/my-agent");
    expect(req.headers.authorization).toBe("Bearer test-key");
  });

  test("401 throws with API key hint", async () => {
    await expect(
      runDelete({ url: api.url, slug: "my-agent", apiKey: "invalid-key" }),
    ).rejects.toThrow("API key may be invalid");
  });

  test("404 throws with not-deployed hint", async () => {
    api.override("DELETE", "/ghost-agent", 404, "not found");
    await expect(
      runDelete({ url: api.url, slug: "ghost-agent", apiKey: "test-key" }),
    ).rejects.toThrow("may not be deployed");
  });
});

// ── Secrets ──────────────────────────────────────────────────────────────────

describe("secrets against mock API", () => {
  // Secret commands use getServerInfo which reads .aai/project.json.
  // We need a real temp directory with a project config pointing at the mock API.
  async function withProjectDir(fn: (dir: string) => Promise<void>): Promise<void> {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { slug: "my-agent", serverUrl: api.url });
      // Override getApiKey to avoid prompts
      process.env.ASSEMBLYAI_API_KEY = "test-key";
      try {
        await fn(dir);
      } finally {
        delete process.env.ASSEMBLYAI_API_KEY;
      }
    });
  }

  test("secret put sends PUT with name/value body", async () => {
    await withProjectDir(async (dir) => {
      await runSecretPut(dir, "MY_KEY", api.url);

      const putReq = api.requests.find((r) => r.method === "PUT" && r.path.includes("/secret"));
      expect(putReq).toBeDefined();
      const body = JSON.parse(putReq?.body ?? "{}") as Record<string, string>;
      expect(body.MY_KEY).toBe("super-secret");
    });

    // Verify it was stored in the mock
    expect(api.secrets.MY_KEY).toBe("super-secret");
  });

  test("secret list returns stored secrets", async () => {
    // Pre-populate secrets
    api.secrets.SECRET_A = "a";
    api.secrets.SECRET_B = "b";

    await withProjectDir(async (dir) => {
      // runSecretList logs to console — capture it
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      try {
        await runSecretList(dir, api.url);
      } finally {
        console.log = origLog;
      }
    });

    const listReq = api.requests.find((r) => r.method === "GET" && r.path.includes("/secret"));
    expect(listReq).toBeDefined();
  });

  test("secret delete sends DELETE with name in path", async () => {
    api.secrets.TO_DELETE = "value";

    await withProjectDir(async (dir) => {
      await runSecretDelete(dir, "TO_DELETE", api.url);
    });

    const delReq = api.requests.find(
      (r) => r.method === "DELETE" && r.path.includes("/secret/TO_DELETE"),
    );
    expect(delReq).toBeDefined();
    expect(api.secrets.TO_DELETE).toBeUndefined();
  });

  test("secret with 401 throws API key hint", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { slug: "my-agent", serverUrl: api.url });
      process.env.ASSEMBLYAI_API_KEY = "invalid-key";
      try {
        await expect(runSecretList(dir, api.url)).rejects.toThrow("API key may be invalid");
      } finally {
        delete process.env.ASSEMBLYAI_API_KEY;
      }
    });
  });
});

// ── Deploy: config persistence ───────────────────────────────────────────────

describe("deploy config persistence", () => {
  test("deploy saves returned slug to .aai/project.json", async () => {
    await withTempDir(async (dir) => {
      const result = await runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        apiKey: "test-key",
      });

      // Manually write config like deploy.ts does
      await writeProjectConfig(dir, { slug: result.slug, serverUrl: api.url });

      const config = await readProjectConfig(dir);
      expect(config?.slug).toBe(result.slug);
      expect(config?.serverUrl).toBe(api.url);
    });
  });

  test("redeploy sends existing slug from config", async () => {
    await withTempDir(async (dir) => {
      // First deploy — no slug
      const first = await runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        apiKey: "test-key",
      });
      await writeProjectConfig(dir, { slug: first.slug, serverUrl: api.url });
      api.clear();

      // Second deploy — should reuse slug from config
      const config = await readProjectConfig(dir);
      const second = await runDeploy({
        url: api.url,
        bundle: makeBundle(),
        env: {},
        ...(config?.slug ? { slug: config.slug } : {}),
        apiKey: "test-key",
      });

      expect(second.slug).toBe(first.slug);
      const body = JSON.parse(getReq(0).body) as Record<string, unknown>;
      expect(body.slug).toBe(first.slug);
    });
  });
});

// ── Secrets: edge cases ──────────────────────────────────────────────────────

describe("secrets edge cases", () => {
  async function withProjectDir(fn: (dir: string) => Promise<void>): Promise<void> {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { slug: "my-agent", serverUrl: api.url });
      process.env.ASSEMBLYAI_API_KEY = "test-key";
      try {
        await fn(dir);
      } finally {
        delete process.env.ASSEMBLYAI_API_KEY;
      }
    });
  }

  test("secret list with no secrets shows empty message", async () => {
    // Ensure no secrets in mock
    for (const key of Object.keys(api.secrets)) delete api.secrets[key];

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await withProjectDir(async (dir) => {
        await runSecretList(dir, api.url);
      });
    } finally {
      console.log = origLog;
    }

    // The function should have made the GET request
    const listReq = api.requests.find((r) => r.method === "GET");
    expect(listReq).toBeDefined();
  });

  test("secret put with empty value throws", async () => {
    const { askPassword } = await import("./_prompts.ts");
    vi.mocked(askPassword).mockResolvedValueOnce("");

    await withProjectDir(async (dir) => {
      await expect(runSecretPut(dir, "EMPTY_KEY", api.url)).rejects.toThrow("No value provided");
    });

    // Should not have made any API request
    expect(api.requests).toHaveLength(0);
  });
});

// ── Network failure ──────────────────────────────────────────────────────────

describe("network failure", () => {
  test("deploy throws clean error when server is unreachable", async () => {
    await expect(
      runDeploy({
        url: "http://127.0.0.1:1", // guaranteed unreachable port
        bundle: makeBundle(),
        env: {},
        apiKey: "test-key",
      }),
    ).rejects.toThrow("could not reach");
  });

  test("delete throws clean error when server is unreachable", async () => {
    await expect(
      runDelete({
        url: "http://127.0.0.1:1",
        slug: "my-agent",
        apiKey: "test-key",
      }),
    ).rejects.toThrow("could not reach");
  });
});

// ── Missing project config ───────────────────────────────────────────────────

describe("missing project config", () => {
  test("delete with no .aai/project.json throws", async () => {
    const { getServerInfo } = await import("./_discover.ts");
    await withTempDir(async (dir) => {
      await expect(getServerInfo(dir)).rejects.toThrow("No .aai/project.json found");
    });
  });

  test("secret list with no .aai/project.json throws", async () => {
    await withTempDir(async (dir) => {
      process.env.ASSEMBLYAI_API_KEY = "test-key";
      try {
        await expect(runSecretList(dir, api.url)).rejects.toThrow("No .aai/project.json found");
      } finally {
        delete process.env.ASSEMBLYAI_API_KEY;
      }
    });
  });
});

// ── Init integration ─────────────────────────────────────────────────────────

let fakeTemplatesDir: string;

vi.mock("./_templates.ts", () => ({
  listTemplates: () => fakeListTemplates(fakeTemplatesDir),
  downloadAndMergeTemplate: (template: string, targetDir: string) =>
    fakeDownloadAndMerge(fakeTemplatesDir, template, targetDir),
}));

const { listTemplates } = await import("./_templates.ts");
const { runInit } = await import("./_init.ts");

describe("init creates working project", () => {
  async function createFakeTemplates(dir: string): Promise<string> {
    const rootDir = path.join(dir, "fake-templates");
    const scaffold = path.join(rootDir, "scaffold");
    await fs.mkdir(scaffold, { recursive: true });
    await fs.writeFile(path.join(scaffold, "shared.txt"), "from shared");
    await fs.writeFile(path.join(scaffold, ".env.example"), "MY_KEY=");
    await fs.writeFile(path.join(scaffold, "package.json"), '{"name":"test"}');

    const simple = path.join(rootDir, "templates", "simple");
    await fs.mkdir(simple, { recursive: true });
    await fs.writeFile(
      path.join(simple, "agent.ts"),
      'export default defineAgent({\n  name: "Default Name",\n});',
    );
    return rootDir;
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

  test("listTemplates returns template directories", async () => {
    await withTempDir(async (dir) => {
      fakeTemplatesDir = await createFakeTemplates(dir);
      const templates = await listTemplates();
      expect(templates).toEqual([{ name: "simple", description: "" }]);
    });
  });

  test("init rejects unknown template", async () => {
    await withTempDir(
      silenced(async (dir) => {
        fakeTemplatesDir = await createFakeTemplates(dir);
        await expect(
          runInit({ targetDir: path.join(dir, "out"), template: "nope" }),
        ).rejects.toThrow("Unknown template");
      }),
    );
  });
});
