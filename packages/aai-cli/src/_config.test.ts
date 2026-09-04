// Copyright 2025 the AAI authors. MIT license.
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readProjectConfig, writeProjectConfig } from "./_config.ts";
import { withTempDir } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";

// Keep the real module surface (`log` is needed by _ui.ts) and stub the prompts.
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  password: vi.fn(),
  isCancel: vi.fn(),
  cancel: vi.fn(),
}));

describe("readProjectConfig / writeProjectConfig", () => {
  test("returns null when no config exists", async () => {
    await withTempDir(async (dir) => {
      const result = await readProjectConfig(dir);
      expect(result).toBeNull();
    });
  });

  test("round-trips config data", async () => {
    await withTempDir(async (dir) => {
      const config = { slug: "test-slug", serverUrl: "https://example.com" };
      await writeProjectConfig(dir, config);
      const result = await readProjectConfig(dir);
      expect(result).toEqual(config);
    });
  });

  test("creates .aai directory if missing", async () => {
    await withTempDir(async (dir) => {
      const config = { slug: "slug", serverUrl: "https://example.com" };
      await writeProjectConfig(dir, config);
      const aaiDir = path.join(dir, ".aai");
      expect(await fileExists(aaiDir)).toBe(true);
    });
  });

  test("overwrites existing config", async () => {
    await withTempDir(async (dir) => {
      await writeProjectConfig(dir, { slug: "old", serverUrl: "https://old.com" });
      await writeProjectConfig(dir, { slug: "new", serverUrl: "https://new.com" });
      const result = await readProjectConfig(dir);
      expect(result?.slug).toBe("new");
    });
  });

  test("throws a clear error for a corrupted project.json (never null)", async () => {
    await withTempDir(async (dir) => {
      // Returning null here would make deploy generate a NEW slug and orphan
      // the live deployment — corruption must be loud.
      const fsp = await import("node:fs/promises");
      const file = path.join(dir, ".aai", "project.json");
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, "{ definitely not json");
      await expect(readProjectConfig(dir)).rejects.toThrow(`project.json is corrupted at ${file}`);
    });
  });
});

describe("getConfigDir", () => {
  // The suite-wide setup file sets AAI_CONFIG_DIR (see _test-setup.ts);
  // clear it here so the env-paths default is what's under test. VITEST is
  // pinned explicitly because one test below clears it; `unstubEnvs` in
  // vitest.shared.ts is what keeps that from leaking into later tests.
  beforeEach(() => {
    vi.stubEnv("AAI_CONFIG_DIR", "");
    vi.stubEnv("VITEST", "true");
  });

  test("AAI_CONFIG_DIR overrides everything", async () => {
    const { getConfigDir } = await import("./_config.ts");
    vi.stubEnv("AAI_CONFIG_DIR", "/tmp/aai-override");
    expect(getConfigDir()).toBe("/tmp/aai-override");
  });

  test("defaults to the env-paths config dir outside tests", async () => {
    const { getConfigDir } = await import("./_config.ts");
    const envPaths = (await import("env-paths")).default;
    vi.stubEnv("VITEST", "");
    expect(getConfigDir()).toBe(envPaths("aai", { suffix: "" }).config);
  });

  test("never resolves the developer's real config dir under vitest", async () => {
    // Fail-closed: a test that reaches approveServer/ensureApiKey without an
    // explicit AAI_CONFIG_DIR must not write to the real config. That file is
    // the trust anchor for `serverUrl` in `.aai/project.json`, so an approved
    // origin leaked there lets a cloned repo receive the developer's API key
    // with no prompt. This lives in the code path, not a vitest setup file,
    // because setup files are per-config and every config can omit one —
    // vitest.slow.config.ts did, which is how the real config got polluted.
    const { getConfigDir } = await import("./_config.ts");
    const envPaths = (await import("env-paths")).default;
    expect(process.env.VITEST).toBeTruthy();
    expect(getConfigDir()).not.toBe(envPaths("aai", { suffix: "" }).config);
  });

  test("the under-vitest fallback dir is stable within a process", async () => {
    // Callers read-modify-write the same config across calls; a fresh temp dir
    // per call would silently drop what the previous call wrote.
    const { getConfigDir } = await import("./_config.ts");
    expect(getConfigDir()).toBe(getConfigDir());
  });
});

describe("readGlobalConfig / writeGlobalConfig", () => {
  test("returns empty object when no config exists", async () => {
    await withTempDir(async (dir) => {
      const { readGlobalConfig } = await import("./_config.ts");
      const result = await readGlobalConfig(dir);
      expect(result).toEqual({});
    });
  });

  test("round-trips config data", async () => {
    await withTempDir(async (dir) => {
      const { readGlobalConfig, writeGlobalConfig } = await import("./_config.ts");
      await writeGlobalConfig(dir, { apiKey: "test-key-123" });
      const result = await readGlobalConfig(dir);
      expect(result).toEqual({ apiKey: "test-key-123" });
    });
  });

  test("creates config directory if missing (nested path)", async () => {
    await withTempDir(async (dir) => {
      const { readGlobalConfig, writeGlobalConfig } = await import("./_config.ts");
      const nested = path.join(dir, "deep", "nested", "config");
      await writeGlobalConfig(nested, { apiKey: "nested-key" });
      const result = await readGlobalConfig(nested);
      expect(result).toEqual({ apiKey: "nested-key" });
      expect(await fileExists(nested)).toBe(true);
    });
  });
});

describe("ensureApiKey", () => {
  // Several tests below export ASSEMBLYAI_API_KEY to prove it is ignored;
  // `unstubEnvs` in vitest.shared.ts is what keeps that out of later tests.

  test("returns saved key without prompting", async () => {
    const p = await import("@clack/prompts");
    await withTempDir(async (dir) => {
      const { writeGlobalConfig, ensureApiKey } = await import("./_config.ts");
      await writeGlobalConfig(dir, { apiKey: "existing-key" });
      const key = await ensureApiKey(dir);
      expect(key).toBe("existing-key");
      expect(p.password).not.toHaveBeenCalled();
    });
    vi.mocked(p.password).mockReset();
  });

  /**
   * Pretend stdin is a TTY for the duration of `fn`. The prompt path is
   * gated on `process.stdin.isTTY` (a real non-TTY run must fail fast, not
   * prompt), and the test process itself has no TTY.
   */
  async function withTtyStdin(fn: () => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await fn();
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }

  test("directs an unauthenticated user to `aai login` instead of prompting", async () => {
    const p = await import("@clack/prompts");

    // Pasting a raw key is no longer an authentication path. `aai login`
    // links a real account (and is what the studio's own onboarding sets up),
    // so a pasted key produced a half-configured CLI that could push and
    // publish while belonging to no account the user could see.
    await withTtyStdin(() =>
      withTempDir(async (dir) => {
        const { ensureApiKey } = await import("./_config.ts");
        await expect(ensureApiKey(dir)).rejects.toMatchObject({
          code: "not_logged_in",
          hint: expect.stringContaining("aai login"),
        });
        expect(p.password).not.toHaveBeenCalled();
      }),
    );
  });

  test("refuses the same way with no TTY — the failure is not about prompting", async () => {
    const p = await import("@clack/prompts");

    await withTempDir(async (dir) => {
      const { ensureApiKey } = await import("./_config.ts");
      await expect(ensureApiKey(dir)).rejects.toMatchObject({
        code: "not_logged_in",
        hint: expect.stringContaining("aai login"),
      });
      expect(p.password).not.toHaveBeenCalled();
    });
  });

  /**
   * `ASSEMBLYAI_API_KEY` is NOT an authentication path. It used to be, and it
   * left the CLI authenticated as whatever key happened to be exported —
   * belonging to no account visible in the studio — and then PERSISTED that
   * key into the global config, so the CLI stayed logged in as it long after
   * the export was gone. In a project the same variable means a *provider*
   * credential in `.env` (see `aai dev`), which is why an export must not
   * quietly become a platform identity.
   */
  test("ignores an exported ASSEMBLYAI_API_KEY", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "env-var-key");

    await withTempDir(async (dir) => {
      const { ensureApiKey } = await import("./_config.ts");
      await expect(ensureApiKey(dir)).rejects.toMatchObject({
        code: "not_logged_in",
        hint: expect.stringContaining("aai login"),
      });
    });
  });

  test("does not write the exported key into the global config", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "env-var-key");

    await withTempDir(async (dir) => {
      const { readGlobalConfig, ensureApiKey } = await import("./_config.ts");
      await expect(ensureApiKey(dir)).rejects.toThrow();
      // A refusal must leave no credential behind: a persisted env key would
      // authenticate every LATER invocation, export or not.
      expect((await readGlobalConfig(dir)).apiKey).toBeUndefined();
    });
  });

  /**
   * `"local-session"` is `aai dev` asking for a PROVIDER credential, and the
   * account-shaped `not_logged_in` sentence was the whole defect: it names only
   * `aai login` and `AAI_CONFIG_DIR`, so a developer with two purely local ways
   * forward read it as "local development is gated on a cloud account" — which
   * is what most of a twenty-persona DX audit concluded before abandoning
   * `aai dev` altogether.
   */
  describe('use: "local-session"', () => {
    test("names .env and a shell export BEFORE `aai login`", async () => {
      await withTempDir(async (dir) => {
        const { ensureApiKey } = await import("./_config.ts");
        const err = await ensureApiKey(dir, "local-session").catch((e: unknown) => e);
        expect(err).toMatchObject({
          code: "missing_assemblyai_key",
          message: expect.stringContaining("ASSEMBLYAI_API_KEY"),
        });
        const hint = (err as { hint: string }).hint;
        // ORDER is the assertion, not mere presence: the two remedies that need
        // no account have to come first, or the message reads as an account
        // requirement with a workaround appended.
        expect(hint).toContain(".env");
        expect(hint).toContain("export ASSEMBLYAI_API_KEY=");
        expect(hint).toContain("aai login");
        expect(hint.indexOf(".env")).toBeLessThan(hint.indexOf("aai login"));
        expect(hint.indexOf("export ASSEMBLYAI_API_KEY=")).toBeLessThan(hint.indexOf("aai login"));
      });
    });

    test("still returns the logged-in key when there is one", async () => {
      // The login key stays a FALLBACK for `aai dev` — the new message is about
      // the failure, not about removing the convenience.
      await withTempDir(async (dir) => {
        const { writeGlobalConfig, ensureApiKey } = await import("./_config.ts");
        await writeGlobalConfig(dir, { apiKey: "logged-in-key" });
        await expect(ensureApiKey(dir, "local-session")).resolves.toBe("logged-in-key");
      });
    });

    test("the platform default is untouched — an account IS the requirement there", async () => {
      // `publish`/`push`/`logs`/`secret` reach the platform, so their refusal
      // must keep pointing at `aai login` and must NOT offer a local key.
      await withTempDir(async (dir) => {
        const { ensureApiKey } = await import("./_config.ts");
        const err = await ensureApiKey(dir).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "not_logged_in" });
        expect((err as { hint: string }).hint).not.toContain(".env");
      });
    });
  });

  test("the saved login key wins even with a different key exported", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "env-var-key");

    await withTempDir(async (dir) => {
      const { writeGlobalConfig, ensureApiKey } = await import("./_config.ts");
      await writeGlobalConfig(dir, { apiKey: "logged-in-key" });
      await expect(ensureApiKey(dir)).resolves.toBe("logged-in-key");
    });
  });
});

/**
 * The global config is one document shared by every command and every
 * terminal, and each writer replaces the whole thing. `writeJson` makes each
 * write atomic, so no reader sees a torn file — but the read→modify→write SPAN
 * was unserialized, so concurrent invocations lost each other's updates.
 *
 * The case that made this worth locking is the API key: `aai login` polls for
 * up to five minutes while the user approves in the browser, so any command run
 * in that window can be mid-update when the key lands — and then writes its own
 * stale snapshot back over it, leaving the user `not_logged_in` right after a
 * login that reported success.
 */
describe("global config concurrent updates", () => {
  test("concurrent approveServer calls do not lose approvals", async () => {
    await withTempDir(async (dir) => {
      const { approveServer, readGlobalConfig, writeGlobalConfig } = await import("./_config.ts");
      await writeGlobalConfig(dir, { approvedServers: [] });

      const origins = Array.from({ length: 8 }, (_, i) => `http://127.0.0.1:900${i}`);
      await Promise.all(origins.map((origin) => approveServer(origin, dir)));

      const approved = (await readGlobalConfig(dir)).approvedServers ?? [];
      expect([...approved].sort()).toEqual([...origins].sort());
    });
  });

  test("a concurrent approveServer cannot discard the login key", async () => {
    await withTempDir(async (dir) => {
      const { approveServer, readGlobalConfig, updateGlobalConfig, writeGlobalConfig } =
        await import("./_config.ts");

      // Repeat: the lost update depends on interleaving, so a single pass can
      // pass by luck even with the serialization removed.
      for (let i = 0; i < 20; i++) {
        await writeGlobalConfig(dir, { approvedServers: [] });
        await Promise.all([
          approveServer(`http://127.0.0.1:9${String(i).padStart(3, "0")}`, dir),
          updateGlobalConfig((config) => ({ ...config, apiKey: "key-from-login" }), dir),
        ]);
        const after = await readGlobalConfig(dir);
        expect(after.apiKey).toBe("key-from-login");
        expect(after.approvedServers).toHaveLength(1);
      }
    });
  });

  test("leaves no lock file behind", async () => {
    await withTempDir(async (dir) => {
      const { approveServer } = await import("./_config.ts");
      await approveServer("https://example.com", dir);
      expect(await fileExists(path.join(dir, "config.lock"))).toBe(false);
    });
  });

  test("a stale lock file is broken rather than blocking forever", async () => {
    await withTempDir(async (dir) => {
      const { approveServer, readGlobalConfig } = await import("./_config.ts");
      const fs = await import("node:fs/promises");
      const lockPath = path.join(dir, "config.lock");
      await fs.writeFile(lockPath, "");
      // Backdate well past the staleness window — a process killed mid-update
      // must not make every later config write take the unlocked path forever.
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, old, old);

      await approveServer("https://example.com", dir);
      expect((await readGlobalConfig(dir)).approvedServers).toEqual(["https://example.com"]);
    });
  });

  test("an UNBREAKABLE stale lock proceeds unlocked instead of spinning forever", async () => {
    await withTempDir(async (dir) => {
      const { approveServer, readGlobalConfig } = await import("./_config.ts");
      const fs = await import("node:fs/promises");
      const lockPath = path.join(dir, "config.lock");
      // A DIRECTORY at the lock path. `fs.rm`'s `force` masks only ENOENT and
      // there is no `recursive`, so breaking it throws every time — and the
      // throw used to be swallowed by a `continue` that restarted the loop
      // ABOVE the deadline check. `aai login` then spun in a tight async loop
      // with no output and no exit; this test hung rather than failing.
      await fs.mkdir(lockPath);
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, old, old);

      const started = Date.now();
      await approveServer("https://example.com", dir);

      // Bounded acquisition, then the documented degrade-to-unlocked path.
      // An unbreakable lock is detected on the FIRST turn, so this must come
      // back well inside the 2s acquisition budget — the old `< 10_000` bound
      // could not tell "returned at once" from "spun until the vitest timeout
      // was nearly up", which is the bug the test exists for.
      expect(Date.now() - started).toBeLessThan(1000);
      expect((await readGlobalConfig(dir)).approvedServers).toEqual(["https://example.com"]);
      // The directory is not ours, so teardown must leave it alone.
      expect((await fs.stat(lockPath)).isDirectory()).toBe(true);
    });
  });

  test("a lock held by someone else is waited out, then the update still lands", async () => {
    await withTempDir(async (dir) => {
      const { approveServer, readGlobalConfig } = await import("./_config.ts");
      const fs = await import("node:fs/promises");
      const lockPath = path.join(dir, "config.lock");
      // Fresh, so not stale: acquisition waits out its 2s budget and then
      // proceeds unlocked rather than throwing — failing `aai login` over a
      // stuck lockfile would be worse than the lost update.
      await fs.writeFile(lockPath, "");

      const started = Date.now();
      await approveServer("https://example.com", dir);

      // The behaviour is "wait out the 2s budget, THEN proceed unlocked", so
      // the bound is two-sided: `< 10_000` alone passed for an implementation
      // that gave up instantly as well as for one that nearly hit the runner's
      // 5s timeout. This is the one test in the file that deliberately spends
      // real wall clock; the budget is a module constant with no injection
      // seam, so shortening it would mean a production knob that exists only
      // for a test.
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1500);
      expect(elapsed).toBeLessThan(4000);
      expect((await readGlobalConfig(dir)).approvedServers).toEqual(["https://example.com"]);
    });
  });
});

describe("updateGlobalConfig", () => {
  test("an unchanged return skips the write", async () => {
    await withTempDir(async (dir) => {
      const { updateGlobalConfig, writeGlobalConfig } = await import("./_config.ts");
      const file = path.join(dir, "config.json");
      await writeGlobalConfig(dir, { apiKey: "k" });
      const { stat } = await import("node:fs/promises");
      const mtimeBefore = (await stat(file)).mtimeMs;

      // Identity return = "nothing to do": most `--server` invocations pass an
      // already-approved origin, and rewriting the file there is pure churn.
      await updateGlobalConfig((config) => config, dir);
      expect((await stat(file)).mtimeMs).toBe(mtimeBefore);
    });
  });

  test("merges against contents read inside the lock", async () => {
    await withTempDir(async (dir) => {
      const { updateGlobalConfig, readGlobalConfig, writeGlobalConfig } = await import(
        "./_config.ts"
      );
      await writeGlobalConfig(dir, { approvedServers: ["https://a.example"] });
      await updateGlobalConfig((config) => ({ ...config, apiKey: "k" }), dir);

      const after = await readGlobalConfig(dir);
      expect(after).toEqual({ approvedServers: ["https://a.example"], apiKey: "k" });
    });
  });
});
