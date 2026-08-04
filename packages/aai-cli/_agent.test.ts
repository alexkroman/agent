// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SERVER,
  getServerInfo,
  isDevMode,
  resolveDeployTarget,
  resolveServerUrl,
} from "./_agent.ts";
import { writeProjectConfig } from "./_config.ts";
import { withTempDir } from "./_test-utils.ts";

// Avoid the interactive API key prompt — getServerInfo resolves keys via ensureApiKey.
vi.mock("./_config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_config.ts")>();
  return {
    ...actual,
    ensureApiKey: vi.fn(() => Promise.resolve("test-key-123")),
  };
});

test("DEFAULT_SERVER", () => {
  expect(DEFAULT_SERVER).toBe("https://alexkroman--aai-server-web-server.modal.run");
});

describe("resolveServerUrl", () => {
  test("explicit URL takes priority", () => {
    expect(resolveServerUrl("https://custom.com", "https://config.com")).toBe("https://custom.com");
  });

  test("dev mode takes priority over config URL", () => {
    // Tests run from the monorepo, so isDevMode() returns true
    expect(resolveServerUrl(undefined, "https://config.com")).toBe("http://localhost:8080");
  });

  test("strips trailing slashes so URL joins can't double up", () => {
    expect(resolveServerUrl("https://custom.com/")).toBe("https://custom.com");
    expect(resolveServerUrl("https://custom.com//")).toBe("https://custom.com");
  });
});

describe("getServerInfo", () => {
  test("throws when no project config exists", async () => {
    await withTempDir(async (dir) => {
      await expect(getServerInfo(dir)).rejects.toThrow("no deployed agent");
    });
  });

  test("error message suggests aai publish", async () => {
    await withTempDir(async (dir) => {
      await expect(getServerInfo(dir)).rejects.toThrow("aai publish");
    });
  });

  test("returns config with resolved api key", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, {
        slug: "my-agent",
        serverUrl: "https://my-server.com",
      });
      const info = await getServerInfo(dir);
      expect(info.slug).toBe("my-agent");
      // Dev mode (monorepo) takes priority over config serverUrl
      expect(info.serverUrl).toBe("http://localhost:8080");
      expect(info.apiKey).toBe("test-key-123");
    });
  });

  test("explicit server overrides config server", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, {
        slug: "agent",
        serverUrl: "https://config-server.com",
      });
      const info = await getServerInfo(dir, "https://override.com");
      expect(info.serverUrl).toBe("https://override.com");
    });
  });
});

describe("resolveDeployTarget", () => {
  // The slug from `.aai/project.json` is repo-controlled and gets
  // interpolated into credentialed URL paths. `getServerInfo` validated it;
  // `resolveDeployTarget` did not — and `aai publish` uses the latter, then
  // hands the slug to `syncEnvSecrets`, which PUTs the whole `.env` to
  // `${serverUrl}/${slug}/secret`. A hostile slug therefore steered a
  // request carrying the API key and every secret value to a path of the
  // repo's choosing. Validating at this one choke point covers every command
  // that resolves a target, including ones added later.
  test.each([
    ["a/../../traversed/target", "path traversal"],
    ["UPPER", "uppercase"],
    ["x", "too short"],
    ["has space", "whitespace"],
    ["sneaky?query=1", "query injection"],
  ])("refuses the repo-controlled slug %j (%s)", async (slug) => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { slug, serverUrl: "https://config-server.com" });
      await expect(resolveDeployTarget(dir)).rejects.toThrow("Invalid slug");
    });
  });

  test("a valid slug resolves normally", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { slug: "my-agent", serverUrl: "https://config-server.com" });
      const target = await resolveDeployTarget(dir);
      expect(target.config?.slug).toBe("my-agent");
    });
  });

  test("a project with no slug yet is fine — pull and first push have none", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { serverUrl: "https://config-server.com" });
      const target = await resolveDeployTarget(dir);
      expect(target.config?.slug).toBeUndefined();
    });
  });
});

describe("isDevMode", () => {
  test("returns true when running from monorepo", () => {
    expect(isDevMode()).toBe(true);
  });
});
