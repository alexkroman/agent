// Copyright 2026 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readProjectConfig, writeProjectConfig } from "./_config.ts";
import { withTempDir } from "./_test-utils.ts";

// resolveDeployTarget is the single auth/target resolver; each test shapes
// its `config` to model an unlinked, linked, or deployed project directory.
const resolveDeployTarget = vi.hoisted(() => vi.fn());
vi.mock("./_agent.ts", () => ({
  resolveDeployTarget,
  isDevMode: vi.fn().mockReturnValue(false),
  getMonorepoRoot: vi.fn().mockReturnValue(null),
}));

vi.mock("./_ui.ts", async () => ({
  log: (await import("./_test-utils.ts")).makeMockLog(),
  fmtUrl: (url: string) => url,
}));

const mockApiRequest = vi.hoisted(() => vi.fn());
// Only `apiRequest` is faked. The response GUARDS (`checkedResponse`,
// `isStringArray`) stay real — they are part of what these specs exercise, and
// a factory that omitted them would make every guarded call site undefined.
vi.mock("./_api-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_api-client.ts")>()),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  HINT_NOT_DEPLOYED: "not-deployed-hint",
}));

const { collectSourceFiles, projectNameFromDir } = await import("./_studio.ts");
const { executeList, executePull, executePush, executePublish } = await import("./studio.ts");
const { executeDelete } = await import("./delete.ts");

const TARGET = { config: null, serverUrl: "https://api.test", apiKey: "key1" };

beforeEach(() => {
  resolveDeployTarget.mockResolvedValue(TARGET);
});

afterEach(() => {
  mockApiRequest.mockReset();
  resolveDeployTarget.mockReset();
});

/** Route apiRequest by URL suffix — the commands compose multiple calls. */
function routeApi(routes: Record<string, unknown | ((opts: never) => unknown)>): void {
  mockApiRequest.mockImplementation((url: string, opts: { method?: string }) => {
    for (const [key, value] of Object.entries(routes)) {
      const [method, suffix] = key.split(" ", 2) as [string, string];
      if ((opts.method ?? "GET") === method && url.endsWith(suffix)) {
        return Promise.resolve(typeof value === "function" ? value(opts as never) : value);
      }
    }
    return Promise.reject(new Error(`unrouted: ${opts.method ?? "GET"} ${url}`));
  });
}

describe("projectNameFromDir", () => {
  test("derives a slug-grammar name; null when unusable", () => {
    expect(projectNameFromDir("/x/My Support Agent")).toBe("my-support-agent");
    expect(projectNameFromDir("/x/voice-agent")).toBe("voice-agent");
    expect(projectNameFromDir("/x/!!!")).toBeNull();
  });

  test("normalizes the way the studio does, transliteration included", () => {
    // The platform's own slugifier, not a local strip — a regex over
    // `[^a-z0-9-_]` reduces this directory to `caf-ordering` while typing
    // the same name into the studio gives `cafe-ordering`, so one human
    // name produced two projects depending on which path created it.
    expect(projectNameFromDir("/x/Café Ordering")).toBe("cafe-ordering");
    expect(projectNameFromDir("/x/my_agent")).toBe("my-agent");
  });

  test("refuses a `-preview` name, which the studio's reaper owns", () => {
    // Publishing such a project would claim `<name>` as a production slug
    // ending in `-preview` — swept hourly by the orphan-preview job, taking
    // the agent's app database and secrets with it. Better to refuse the
    // name up front than to hand back an agent with an expiry date.
    expect(projectNameFromDir("/x/demo-preview")).toBeNull();
    expect(projectNameFromDir("/x/My Demo Preview")).toBeNull();
    // Only the exact suffix is reserved — a name merely containing it is fine.
    expect(projectNameFromDir("/x/preview-tool")).toBe("preview-tool");
  });
});

describe("collectSourceFiles", () => {
  test("skips secrets, lockfiles, ignored dirs, and oversized files", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export {};");
      await fs.writeFile(path.join(dir, ".env"), "SECRET=1");
      await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lock");
      await fs.writeFile(path.join(dir, "huge.txt"), "x".repeat(256_001));
      await fs.mkdir(path.join(dir, "node_modules/dep"), { recursive: true });
      await fs.writeFile(path.join(dir, "node_modules/dep/index.js"), "no");
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      await fs.writeFile(path.join(dir, "src/client.tsx"), "ui");

      const { files, warnings } = await collectSourceFiles(dir);
      expect(Object.keys(files).sort()).toEqual(["agent.ts", "src/client.tsx"]);
      expect(warnings.some((w) => w.includes("huge.txt"))).toBe(true);
    });
  });

  test("skips binary files instead of silently mangling them", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export {};");
      // A real PNG header: 0x89 is not valid UTF-8, so a utf-8 read replaces
      // it (and every other invalid byte) with U+FFFD. The workspace file map
      // is JSON — it cannot carry these bytes — so the only honest options are
      // skip-with-a-warning or encode. Reading them as text produced a push
      // that reported success while destroying the asset, and a later `aai
      // pull` wrote the mangled bytes back over the local original.
      await fs.writeFile(
        path.join(dir, "logo.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]),
      );

      const { files, warnings } = await collectSourceFiles(dir);
      expect(Object.keys(files)).toEqual(["agent.ts"]);
      expect(warnings.some((w) => w.includes("logo.png"))).toBe(true);
    });
  });

  test("keeps valid UTF-8 exactly, including BOM, CRLF, and NUL", async () => {
    await withTempDir(async (dir) => {
      // These all round-tripped correctly already; pin that the binary check
      // does not start rejecting legitimate text. A NUL byte in particular is
      // valid UTF-8 and appears in fixtures.
      await fs.writeFile(path.join(dir, "agent.ts"), "export {};");
      await fs.writeFile(path.join(dir, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
      await fs.writeFile(path.join(dir, "crlf.txt"), "a\r\nb\r\n");
      await fs.writeFile(path.join(dir, "nul.txt"), Buffer.from([0x61, 0x00, 0x62]));
      await fs.writeFile(path.join(dir, "utf8.txt"), "héllo — ünïcødé ✅");

      const { files, warnings } = await collectSourceFiles(dir);
      expect(Object.keys(files).sort()).toEqual([
        "agent.ts",
        "bom.txt",
        "crlf.txt",
        "nul.txt",
        "utf8.txt",
      ]);
      expect(files["utf8.txt"]).toBe("héllo — ünïcødé ✅");
      expect(files["crlf.txt"]).toBe("a\r\nb\r\n");
      expect(files["nul.txt"]).toBe("a\u0000b");
      // A BOM must survive: TextDecoder strips it by default, which would
      // make the UTF-8 check itself a (smaller) corruption bug.
      expect(files["bom.txt"]).toBe("\ufeffhi");
      expect(warnings).toEqual([]);
    });
  });
});

describe("executeList", () => {
  test("lists the caller's studio projects", async () => {
    routeApi({ "GET /studio/projects": { projects: ["a", "b"] } });
    const result = await executeList({ cwd: "/tmp" });
    expect(result).toEqual({ ok: true, data: { projects: ["a", "b"] } });
  });

  // The list body was cast, not checked, so a 200 from something that is not
  // an aai server reached `for (const name of projects)` as `undefined` — and
  // `notFoundHint` calls the same function on an ALREADY-failing path, where a
  // raw TypeError would replace the 404 the user needs to see.
  test.each([
    ["a body with no `projects`", { ok: true }],
    ["a `projects` that is not an array", { projects: "a,b" }],
    ["a `projects` holding non-strings", { projects: [{ name: "a" }] }],
    ["an HTML page", "<!doctype html>"],
  ])("%s is refused with a sentence naming the server", async (_label, body) => {
    routeApi({ "GET /studio/projects": body });
    await expect(executeList({ cwd: "/tmp" })).rejects.toThrow(
      /Unexpected response from the studio project list at https:\/\/api\.test/,
    );
  });
});

describe("executePull", () => {
  test("materializes files, layers the scaffold, and links the directory", async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, "fake-templates/scaffold"), { recursive: true });
      await fs.writeFile(path.join(dir, "fake-templates/scaffold/tsconfig.json"), "{}");
      // The scaffold must never overwrite a workspace file of the same name.
      await fs.writeFile(path.join(dir, "fake-templates/scaffold/agent.ts"), "SCAFFOLD");
      vi.stubEnv("AAI_TEMPLATES_DIR", path.join(dir, "fake-templates"));
      routeApi({
        "GET /studio/projects/proj": {
          files: { "agent.ts": "export {};", "src/client.tsx": "ui" },
          sourceHash: "hash-1",
          deployedSlug: "proj",
        },
      });

      const result = await executePull({ cwd: dir, project: "proj" });
      expect(result.ok).toBe(true);
      const target = path.join(dir, "proj");
      expect(await fs.readFile(path.join(target, "agent.ts"), "utf-8")).toBe("export {};");
      expect(await fs.readFile(path.join(target, "src/client.tsx"), "utf-8")).toBe("ui");
      expect(await fs.readFile(path.join(target, "tsconfig.json"), "utf-8")).toBe("{}");
      expect(await readProjectConfig(target)).toEqual({
        serverUrl: "https://api.test",
        studioProject: "proj",
        studioSourceHash: "hash-1",
        slug: "proj",
      });
    });
  });

  test("404s a missing project and refuses a non-empty directory", async () => {
    await withTempDir(async (dir) => {
      routeApi({ "GET /studio/projects/ghost": null });
      await expect(executePull({ cwd: dir, project: "ghost" })).rejects.toThrow(
        'No studio project named "ghost"',
      );

      routeApi({ "GET /studio/projects/proj": { files: { "a.ts": "x" }, sourceHash: "h" } });
      await fs.mkdir(path.join(dir, "proj"));
      await fs.writeFile(path.join(dir, "proj/existing.txt"), "here");
      await expect(executePull({ cwd: dir, project: "proj" })).rejects.toThrow("is not empty");
      // --force overwrites in place.
      expect((await executePull({ cwd: dir, project: "proj", force: true })).ok).toBe(true);
    });
  });

  // The 404's hint is the only place the two causes are distinguishable: a
  // typo has neighbours, while an empty list means this login is scoped to a
  // different account than the studio the project lives in.
  test("names the visible projects on a 404 — or that there are none", async () => {
    await withTempDir(async (dir) => {
      routeApi({
        "GET /studio/projects/ghost": null,
        "GET /studio/projects": { projects: ["pizza", "support-bot"] },
      });
      await expect(executePull({ cwd: dir, project: "ghost" })).rejects.toMatchObject({
        code: "not_found",
        hint: "Your projects: pizza, support-bot.",
      });

      routeApi({ "GET /studio/projects/ghost": null, "GET /studio/projects": { projects: [] } });
      await expect(executePull({ cwd: dir, project: "ghost" })).rejects.toMatchObject({
        hint: expect.stringContaining("linked to a different account"),
      });

      // The list is a second request on an already-failing path: its failure
      // must not replace the 404.
      routeApi({ "GET /studio/projects/ghost": null });
      await expect(executePull({ cwd: dir, project: "ghost" })).rejects.toMatchObject({
        hint: "Run `aai list` to see your projects.",
      });
    });
  });

  test("rejects pulled paths that escape the target directory", async () => {
    await withTempDir(async (dir) => {
      routeApi({
        "GET /studio/projects/proj": { files: { "../evil.ts": "x" }, sourceHash: "h" },
      });
      await expect(executePull({ cwd: dir, project: "proj" })).rejects.toThrow(
        "escapes the project directory",
      );
    });
  });
});

describe("executePush", () => {
  test("first push links the directory and creates the project", async () => {
    await withTempDir(async (dir) => {
      const cwd = path.join(dir, "voice-agent");
      await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      routeApi({
        "GET /studio/projects/voice-agent": null,
        "PUT /studio/projects/voice-agent/source": (opts: { body: { baseHash?: string } }) => {
          expect(opts.body.baseHash).toBeUndefined();
          return { sourceHash: "hash-2", created: true };
        },
      });

      const result = await executePush({ cwd });
      expect(result).toEqual({
        ok: true,
        data: {
          project: "voice-agent",
          created: true,
          url: "https://api.test/studio/chat/voice-agent",
        },
      });
      expect(await readProjectConfig(cwd)).toEqual({
        serverUrl: "https://api.test",
        studioProject: "voice-agent",
        studioSourceHash: "hash-2",
      });
    });
  });

  test("reports skipped files in the result, not only as a TTY warning", async () => {
    await withTempDir(async (dir) => {
      const cwd = path.join(dir, "voice-agent");
      await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      await fs.writeFile(path.join(cwd, "huge.txt"), "x".repeat(256_001));
      routeApi({
        "GET /studio/projects/voice-agent": null,
        "PUT /studio/projects/voice-agent/source": { sourceHash: "h", created: true },
      });

      // `log.warn` is silenced in JSON mode and JSON mode is auto-detected on
      // a pipe, so a CI or scripted push saw `ok: true` with no indication
      // that files were dropped. Since a push REPLACES the whole workspace
      // file map, a silently truncated push can delete `agent.ts` from an
      // existing project.
      const result = await executePush({ cwd });
      expect(result.ok).toBe(true);
      const data = (result as { data: { warnings?: string[] } }).data;
      expect(data.warnings?.some((w) => w.includes("huge.txt"))).toBe(true);
    });
  });

  test("omits the warnings key entirely when nothing was skipped", async () => {
    await withTempDir(async (dir) => {
      const cwd = path.join(dir, "voice-agent");
      await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      routeApi({
        "GET /studio/projects/voice-agent": null,
        "PUT /studio/projects/voice-agent/source": { sourceHash: "h", created: true },
      });

      const result = await executePush({ cwd });
      expect(result).toEqual({
        ok: true,
        data: {
          project: "voice-agent",
          created: true,
          url: "https://api.test/studio/chat/voice-agent",
        },
      });
    });
  });

  test("rejects when the entry file exists but was dropped, naming the real reason", async () => {
    await withTempDir(async (dir) => {
      const cwd = path.join(dir, "voice-agent");
      await fs.mkdir(cwd);
      // A second file keeps the tree non-empty so this hits the entry check
      // rather than the "nothing to push" guard.
      await fs.writeFile(path.join(cwd, "helper.ts"), "export const x = 1;");
      // agent.ts over the byte cap is DROPPED by collectSourceFiles with only a
      // warning (silenced in JSON mode). Push used to report ok while shipping
      // a tree with no entry, and the server then answered a confusing
      // "No agent.ts found in the current directory". Fail here, naming the cap.
      await fs.writeFile(path.join(cwd, "agent.ts"), `export {};\n// ${"x".repeat(256_001)}`);
      await expect(executePush({ cwd })).rejects.toThrow(/agent\.ts is \d+ bytes .*not synced/);
    });
  });

  test("an unlinked push refuses to overwrite a same-named studio project", async () => {
    await withTempDir(async (dir) => {
      const cwd = path.join(dir, "voice-agent");
      await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      routeApi({
        "GET /studio/projects/voice-agent": { files: { "agent.ts": "theirs" }, sourceHash: "h9" },
      });
      await expect(executePush({ cwd })).rejects.toThrow("already has a project named");
    });
  });

  test("a linked push sends the recorded fast-forward token", async () => {
    await withTempDir(async (cwd) => {
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      resolveDeployTarget.mockResolvedValue({
        ...TARGET,
        config: {
          serverUrl: "https://api.test",
          studioProject: "proj",
          studioSourceHash: "hash-1",
          slug: "proj",
        },
      });
      routeApi({
        "PUT /studio/projects/proj/source": (opts: { body: { baseHash?: string } }) => {
          expect(opts.body.baseHash).toBe("hash-1");
          return { sourceHash: "hash-2", created: false };
        },
      });

      const result = await executePush({ cwd });
      expect(result.ok).toBe(true);
      expect((await readProjectConfig(cwd))?.studioSourceHash).toBe("hash-2");
    });
  });

  test("--force omits the token entirely", async () => {
    await withTempDir(async (cwd) => {
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      resolveDeployTarget.mockResolvedValue({
        ...TARGET,
        config: { serverUrl: "https://api.test", studioProject: "proj", studioSourceHash: "h1" },
      });
      routeApi({
        "PUT /studio/projects/proj/source": (opts: { body: { baseHash?: string } }) => {
          expect(opts.body.baseHash).toBeUndefined();
          return { sourceHash: "h2", created: false };
        },
      });
      expect((await executePush({ cwd, force: true })).ok).toBe(true);
    });
  });
});

describe("executePublish", () => {
  test("pushes, syncs .env secrets before the deploy, and records the slug", async () => {
    await withTempDir(async (cwd) => {
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      await fs.writeFile(path.join(cwd, ".env"), "MY_SECRET=shh");
      resolveDeployTarget.mockResolvedValue({
        ...TARGET,
        config: {
          serverUrl: "https://api.test",
          studioProject: "proj",
          studioSourceHash: "h1",
          slug: "proj",
        },
      });
      const order: string[] = [];
      routeApi({
        "PUT /studio/projects/proj/source": () => {
          order.push("push");
          return { sourceHash: "h2", created: false };
        },
        "PUT /proj/secret": (opts: { body: Record<string, string> }) => {
          order.push("secrets");
          expect(opts.body).toEqual({ MY_SECRET: "shh" });
          return { ok: true };
        },
        "POST /studio/projects/proj/deploy": () => {
          order.push("deploy");
          return { ok: true, slug: "proj", url: "/proj/", output: "Deployed /proj/" };
        },
      });

      const result = await executePublish({ cwd, skipTypecheck: true });
      expect(result).toEqual({
        ok: true,
        data: {
          project: "proj",
          slug: "proj",
          url: "https://api.test/proj",
          studioUrl: "https://api.test/studio/chat/proj",
          output: "Deployed /proj/",
        },
      });
      // Secrets merge into the agent env AT deploy time — order is the point.
      expect(order).toEqual(["push", "secrets", "deploy"]);
      expect((await readProjectConfig(cwd))?.slug).toBe("proj");
    });
  });

  test("forwards --skipTypecheck to the deploy route so the in-sandbox build skips its gate", async () => {
    await withTempDir(async (cwd) => {
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      resolveDeployTarget.mockResolvedValue({
        ...TARGET,
        config: {
          serverUrl: "https://api.test",
          studioProject: "proj",
          studioSourceHash: "h1",
          slug: "proj",
        },
      });
      let deployBody: unknown;
      routeApi({
        "PUT /studio/projects/proj/source": { sourceHash: "h2", created: false },
        "POST /studio/projects/proj/deploy": (opts: { body?: unknown }) => {
          deployBody = opts.body;
          return { ok: true, slug: "proj", url: "/proj/", output: "Deployed /proj/" };
        },
      });
      // The client-side gate is skipped here too, but the guest re-runs `aai
      // deploy` which typechecks unconditionally — so the flag has to ride the
      // request body or `aai publish --skipTypecheck` is a silent no-op.
      await executePublish({ cwd, skipTypecheck: true });
      expect(deployBody).toEqual({ skipTypecheck: true });
    });
  });

  test("a publish response missing fields fails cleanly, not with a TypeError", async () => {
    await withTempDir(async (cwd) => {
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      resolveDeployTarget.mockResolvedValue({
        ...TARGET,
        config: { serverUrl: "https://api.test", studioProject: "proj", studioSourceHash: "h1" },
      });
      routeApi({
        "PUT /studio/projects/proj/source": { sourceHash: "h2", created: false },
        // A proxy, an older server, or anything that isn't the deploy route
        // can answer 200 with a body that lacks `slug`/`output`. Reading
        // `result.output.trim()` blind surfaced as
        // "Cannot read properties of undefined (reading 'trim')" — a raw
        // TypeError with nothing actionable in it.
        "POST /studio/projects/proj/deploy": {},
      });

      // Thrown as a CliError; `runCommand` turns it into the one JSON result
      // line with its code and hint.
      await expect(executePublish({ cwd, skipTypecheck: true })).rejects.toThrow(
        /Unexpected response from the publish route/,
      );
      await expect(executePublish({ cwd, skipTypecheck: true })).rejects.not.toThrow(/'trim'/);
    });
  });

  test("reports skipped files in the result, like push does", async () => {
    await withTempDir(async (cwd) => {
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      await fs.writeFile(path.join(cwd, "huge.txt"), "x".repeat(256_001));
      resolveDeployTarget.mockResolvedValue({
        ...TARGET,
        config: { serverUrl: "https://api.test", studioProject: "proj", studioSourceHash: "h1" },
      });
      routeApi({
        "PUT /studio/projects/proj/source": { sourceHash: "h2", created: false },
        "POST /studio/projects/proj/deploy": {
          ok: true,
          slug: "proj",
          url: "/proj/",
          output: "Deployed",
        },
        "PUT /proj/secret": { ok: true },
      });

      // Publish is the command that ships to production, so a silently
      // truncated tree matters even more here than on a bare push.
      const result = await executePublish({ cwd, skipTypecheck: true });
      expect(result.ok).toBe(true);
      const data = (result as { data: { warnings?: string[] } }).data;
      expect(data.warnings?.some((w) => w.includes("huge.txt"))).toBe(true);
    });
  });

  test("first publish syncs .env after the slug exists", async () => {
    await withTempDir(async (dir) => {
      const cwd = path.join(dir, "fresh-agent");
      await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, "agent.ts"), "export {};");
      await fs.writeFile(path.join(cwd, ".env"), "K=v");
      const order: string[] = [];
      routeApi({
        "GET /studio/projects/fresh-agent": null,
        "PUT /studio/projects/fresh-agent/source": { sourceHash: "h1", created: true },
        "POST /studio/projects/fresh-agent/deploy": () => {
          order.push("deploy");
          return { ok: true, slug: "fresh-agent", url: "/fresh-agent/", output: "ok" };
        },
        "PUT /fresh-agent/secret": () => {
          order.push("secrets");
          return { ok: true };
        },
      });

      const result = await executePublish({ cwd, skipTypecheck: true });
      expect(result.ok).toBe(true);
      expect(order).toEqual(["deploy", "secrets"]);
    });
  });
});

describe("executeDelete", () => {
  test("a linked directory deletes the STUDIO PROJECT (server-side cascade)", async () => {
    resolveDeployTarget.mockResolvedValue({
      ...TARGET,
      config: { serverUrl: "https://api.test", studioProject: "proj", slug: "proj" },
    });
    routeApi({ "DELETE /studio/projects/proj": { ok: true } });
    const result = await executeDelete({ cwd: "/tmp" });
    expect(result).toEqual({ ok: true, data: { project: "proj", slug: "proj" } });
  });

  test("clears the now-dangling studio link so the next publish can recreate", async () => {
    await withTempDir(async (cwd) => {
      await writeProjectConfig(cwd, {
        serverUrl: "https://api.test",
        studioProject: "proj",
        studioSourceHash: "h1",
        slug: "proj",
      });
      resolveDeployTarget.mockResolvedValue({
        ...TARGET,
        config: await readProjectConfig(cwd),
      });
      routeApi({ "DELETE /studio/projects/proj": { ok: true } });

      await executeDelete({ cwd });

      // Leaving the link behind sent the next push a stale `baseHash` for a
      // project that no longer exists, which the server answers 409 —
      // advising `aai pull`, which then fails with "No studio project named
      // proj". Only `--force` recovered, so the guidance was actively wrong.
      // `serverUrl` stays: it's where the next publish should go.
      expect(await readProjectConfig(cwd)).toEqual({ serverUrl: "https://api.test" });
    });
  });
});
