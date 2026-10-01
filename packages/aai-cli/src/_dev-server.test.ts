// Copyright 2025 the AAI authors. MIT license.
/**
 * `startDevServer`'s wiring, against fakes handed in through `DevServerSeams`
 * (`_dev-server-test-utils.ts`) — no module mocks. The bundler build, `.env`
 * resolution from the fixture, agent validation, the journal and the
 * credential fallback are the real code path; the backend, watcher, Vite,
 * login key, schema DDL and terminal are the fakes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentDef } from "@alexkroman1/aai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { loadWorker, startDevServer } from "./_dev-server.ts";
import { makeDevSeams, writeAgentTs, writeProject } from "./_dev-server-test-utils.ts";
import { withTempDir } from "./_test-utils.ts";

// 30s, not the 5s default: every case runs a real bundler build, and CPU
// starvation under full-repo parallel runs was flaking these otherwise-fast
// tests.
vi.setConfig({ testTimeout: 30_000 });

const DB_URL = "postgres://u:p@127.0.0.1:5432/db";

beforeEach(() => {
  // These suites exercise the watcher, which defaults OFF without a TTY (see
  // devWatchEnabled). `unstubEnvs` in vitest.shared.ts undoes every stub here.
  vi.stubEnv("AAI_DEV_WATCH", "1");
  // Set by `startDevServer` with a plain assignment; stubbing it unset RECORDS
  // the original so the runner restores it before the next test.
  vi.stubEnv("AAI_WORKFLOW_DATA_DIR", undefined);
  // The real `resolveServerEnv` lets the shell win per declared key, and the
  // login-key fallback is skipped when the shell has one — neither may depend
  // on the machine running the suite.
  vi.stubEnv("ASSEMBLYAI_API_KEY", undefined);
  vi.stubEnv("PUBLIC_URL", undefined);
});

describe("startDevServer", () => {
  test("loads agent, resolves env, creates runtime and server", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeDevSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

      expect(fake.lastBuild()?.runtimeOptions).toEqual({
        agent: expect.objectContaining({ name: "test-agent" }),
        env: { ASSEMBLYAI_API_KEY: "test-key" },
        // Credentials resolve from providerEnv; ctx.env stays as `env` so dev
        // matches production in what agent code can read.
        providerEnv: expect.objectContaining({ ASSEMBLYAI_API_KEY: "test-key" }),
        // The runtime logs through a logger this command chooses, so its
        // diagnostics can be kept off stdout in JSON mode (createDevLogger).
        logger: expect.objectContaining({ info: expect.any(Function) }),
        // The run store, built once for the process and handed to every build;
        // identity across rebuilds is `_dev-server-restart.test.ts`'s.
        journal: expect.anything(),
        // What `ctx.workflows.publicWebhookUrl` mints from: the BACKEND port,
        // which with no `client.tsx` is the port passed in.
        publicUrl: "http://localhost:3000",
      });
      expect(fake.lastBuild()?.serverOptions).toMatchObject({
        name: "test-agent",
      });
      // Second arg is the bind host: undefined (AAI_DEV_HOST unset), so the
      // server applies its loopback default.
      expect(fake.listen).toHaveBeenCalledWith(3000, undefined);

      await cleanup();
    });
  });

  test("returns a cleanup function that closes watchers and server", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeDevSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);
      await cleanup();

      expect(fake.watcher.close).toHaveBeenCalled();
      expect(fake.close).toHaveBeenCalled();
    });
  });

  test("uses port directly when no client.tsx exists", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeDevSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 4000 }, fake.seams);

      expect(fake.listen).toHaveBeenCalledWith(4000, undefined);
      expect(fake.seams.createViteServer).not.toHaveBeenCalled();
      await cleanup();
    });
  });

  /**
   * A project with `client.tsx` and its own `vite.config.ts` — so the plugins
   * are the project config's to supply (the default pair is
   * `_client-plugins.test.ts`'s subject).
   */
  async function writeClientProject(dir: string): Promise<void> {
    await writeProject(dir);
    await fs.writeFile(path.join(dir, "client.tsx"), "export {};\n");
    await fs.writeFile(path.join(dir, "vite.config.ts"), "export default {};\n");
  }

  test("uses port+1 for backend when client.tsx exists", async () => {
    await withTempDir(async (dir) => {
      await writeClientProject(dir);
      const fake = makeDevSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

      expect(fake.listen).toHaveBeenCalledWith(3001, undefined);
      expect(fake.vite.listen).toHaveBeenCalled();
      await cleanup();
    });
  });

  // The backend binds the port before Vite boots, and startDevServer throws
  // on a Vite failure — so without an explicit close it stays listening with
  // nothing holding a handle to it, and the retry finds the port occupied.
  test("a Vite failure closes the backend that already bound", async () => {
    await withTempDir(async (dir) => {
      await writeClientProject(dir);
      const fake = makeDevSeams();
      fake.vite.listen.mockRejectedValue(new Error("vite port taken"));

      await expect(startDevServer({ cwd: dir, port: 3000 }, fake.seams)).rejects.toThrow(
        "vite port taken",
      );

      expect(fake.listen).toHaveBeenCalled();
      expect(fake.close).toHaveBeenCalledTimes(1);
      expect(fake.watcher.close).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * A `DATABASE_URL` puts session state in Postgres, and the tables come with
   * whoever OWNS that database — under `aai dev` the developer, with no
   * migration step anywhere. Without the DDL every session died with a fatal
   * 1011 whose real cause reached only the dev log.
   */
  describe("session-state schema", () => {
    test("both DDLs run when the project declares a DATABASE_URL", async () => {
      await withTempDir(async (dir) => {
        await writeProject(dir, { ASSEMBLYAI_API_KEY: "k", DATABASE_URL: DB_URL });
        const fake = makeDevSeams();

        const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

        expect(fake.seams.ensureSessionStateSchema).toHaveBeenCalledWith(
          expect.objectContaining({ url: DB_URL }),
        );
        // The journal's tables had no creator at all: the boot line said
        // `runStore: "postgres"` and the first run died on `42P01`.
        expect(fake.seams.ensureWorkflowJournalSchema).toHaveBeenCalledWith(
          expect.objectContaining({ url: DB_URL }),
        );
        await cleanup();
      });
    });

    test("neither DDL runs without a DATABASE_URL, there being no database to own", async () => {
      await withTempDir(async (dir) => {
        await writeProject(dir, { ASSEMBLYAI_API_KEY: "k" });
        const fake = makeDevSeams();

        const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

        expect(fake.seams.ensureSessionStateSchema).not.toHaveBeenCalled();
        expect(fake.seams.ensureWorkflowJournalSchema).not.toHaveBeenCalled();
        await cleanup();
      });
    });

    /**
     * Before the runtime, which opens its own pool from the same URL and starts
     * serving: a first session landing between the two would take exactly the
     * failure this fixes.
     */
    test("runs before the runtime is built", async () => {
      await withTempDir(async (dir) => {
        await writeProject(dir, { ASSEMBLYAI_API_KEY: "k", DATABASE_URL: DB_URL });
        const fake = makeDevSeams();
        const order: string[] = [];
        fake.seams.ensureSessionStateSchema.mockImplementation(async () => {
          order.push("ddl");
          return true;
        });
        const realServe = fake.serve.getMockImplementation();
        fake.serve.mockImplementation((runtimeOptions, serverOptions) => {
          order.push("runtime");
          return (realServe as NonNullable<typeof realServe>)(runtimeOptions, serverOptions);
        });

        const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

        expect(order).toEqual(["ddl", "runtime"]);
        await cleanup();
      });
    });
  });

  describe("workflow data directory", () => {
    test("points at the PROJECT's .workflow-data, so a save is not a new deployment", async () => {
      await withTempDir(async (dir) => {
        await writeProject(dir);

        const cleanup = await startDevServer({ cwd: dir, port: 3000 }, makeDevSeams().seams);

        // What `localWorkflowDataDir()` reads. Unset, every upload under
        // `aai dev` lands in a fresh per-process tmpdir and is gone on the next.
        expect(process.env.AAI_WORKFLOW_DATA_DIR).toBe(path.join(dir, ".workflow-data"));
        await cleanup();
      });
    });

    test("honours one the developer already exported", async () => {
      await withTempDir(async (dir) => {
        await writeProject(dir);
        vi.stubEnv("AAI_WORKFLOW_DATA_DIR", "/somewhere/else");

        const cleanup = await startDevServer({ cwd: dir, port: 3000 }, makeDevSeams().seams);

        expect(process.env.AAI_WORKFLOW_DATA_DIR).toBe("/somewhere/else");
        await cleanup();
      });
    });
  });

  test("falls back to the logged-in key when .env declares none", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir, { OTHER_VAR: "value" });
      const fake = makeDevSeams();
      fake.seams.ensureApiKey.mockResolvedValue("fallback-key");

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

      // `"local-session"` keeps the FAILURE credential-shaped when there is no
      // key anywhere (see `ApiKeyUse` in _config.ts); the message itself is
      // specced in `_config.test.ts`, and this is where the two are wired.
      expect(fake.seams.ensureApiKey).toHaveBeenCalledWith(undefined, "local-session");
      expect(fake.lastBuild()?.runtimeOptions.env).toMatchObject({
        ASSEMBLYAI_API_KEY: "fallback-key",
      });
      await cleanup();
    });
  });

  /**
   * A shell-exported key does not authenticate the CLI, but it is still a
   * provider credential the dev server honors through
   * `withHostCredentialFallback` — so `aai dev` must not demand a login, and
   * the key must stay out of `ctx.env` (dev/prod parity).
   */
  test("does not require a login when the key is exported in the shell", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir, { OTHER_VAR: "value" });
      vi.stubEnv("ASSEMBLYAI_API_KEY", "shell-key");
      const fake = makeDevSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

      expect(fake.seams.ensureApiKey).not.toHaveBeenCalled();
      expect(fake.lastBuild()?.runtimeOptions.env).not.toHaveProperty("ASSEMBLYAI_API_KEY");
      // ...and the shell-only key is flagged, through `notify` (JSON mode
      // silences `log`, and a long-running `aai dev` is usually piped).
      expect(fake.ui.said("warn").join("\n")).toContain("resolved from your shell, not .env");
      await cleanup();
    });
  });

  test("does not call ensureApiKey when .env declares ASSEMBLYAI_API_KEY", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir, { ASSEMBLYAI_API_KEY: "already-set" });
      const fake = makeDevSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

      expect(fake.seams.ensureApiKey).not.toHaveBeenCalled();
      await cleanup();
    });
  });

  test("sets up file watcher on the agent directory", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeDevSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

      expect(fake.watch).toHaveBeenCalledWith(
        dir,
        expect.objectContaining({
          ignoreInitial: true,
          persistent: false,
          ignored: expect.any(Function),
        }),
      );
      await cleanup();
    });
  });

  test("does NOT watch with no TTY — a harness gets no watcher", async () => {
    // A restart ends in-flight voice sessions: right while editing, wrong while
    // a benchmark drives the host. Cleanup must also survive the absent watcher.
    vi.stubEnv("AAI_DEV_WATCH", "");
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeDevSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

      expect(fake.watch).not.toHaveBeenCalled();
      await expect(cleanup()).resolves.toBeUndefined();
    });
  });

  test("refuses an agent.ts whose default export is not an agent", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), "export default { tools: {} };\n");

      await expect(startDevServer({ cwd: dir, port: 3000 }, makeDevSeams().seams)).rejects.toThrow(
        /configuration is invalid|must export default agent/,
      );
    });
  });

  test("throws when agent.ts has no default export", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), "export const notDefault = 42;\n");

      // The worker wrapper re-exports the default, so a missing default
      // export fails the build itself — with an error naming agent.ts.
      await expect(startDevServer({ cwd: dir, port: 3000 }, makeDevSeams().seams)).rejects.toThrow(
        /"default" is not exported/,
      );
    });
  });

  test("throws when agent.ts file does not exist", async () => {
    await withTempDir(async (dir) => {
      await expect(
        startDevServer({ cwd: dir, port: 3000 }, makeDevSeams().seams),
      ).rejects.toThrow();
    });
  });

  test("provides clientDir when no client.tsx exists", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeDevSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

      expect(fake.lastBuild()?.serverOptions).toMatchObject({ clientDir: expect.any(String) });
      await cleanup();
    });
  });
});

describe("file watcher filtering", () => {
  test("the ignored matcher filters .aai, node_modules and dot-dirs but keeps .env", async () => {
    await withTempDir(async (dir) => {
      await writeProject(dir);
      const fake = makeDevSeams();

      const cleanup = await startDevServer({ cwd: dir, port: 3000 }, fake.seams);

      const ignored = fake.watcher.ignored;
      expect(ignored).toBeDefined();
      expect(ignored?.(path.join(dir, ".aai", "cache"))).toBe(true);
      expect(ignored?.(path.join(dir, "node_modules", "pkg", "index.js"))).toBe(true);
      expect(ignored?.(path.join(dir, "agent.ts"))).toBe(false);
      expect(ignored?.(path.join(dir, "tools", "search.ts"))).toBe(false);
      // .git activity (commits, index writes) must never restart the server.
      expect(ignored?.(path.join(dir, ".git", "index.lock"))).toBe(true);
      expect(ignored?.(path.join(dir, ".vscode", "settings.json"))).toBe(true);
      expect(ignored?.(path.join(dir, "sub", ".hidden", "file.ts"))).toBe(true);
      // .env files stay watched — env edits should restart with new values.
      expect(ignored?.(path.join(dir, ".env"))).toBe(false);
      expect(ignored?.(path.join(dir, ".env.local"))).toBe(false);
      expect(ignored?.(dir)).toBe(false);

      await cleanup();
    });
  });
});

describe("loadWorker", () => {
  const fakeWorker = (name: string) => ({ name, tools: {} }) as AgentDef;

  test("hands the Vite-built worker to the evaluator", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir, "built-agent");
      const evaluated: string[] = [];
      const worker = await loadWorker(dir, async (code) => {
        evaluated.push(code);
        return fakeWorker("built-agent");
      });
      expect(worker.name).toBe("built-agent");
      expect(evaluated[0]).toContain("built-agent");
    });
  });

  test("compile errors in the agent's code propagate", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir);
      await fs.writeFile(path.join(dir, "agent.ts"), "export default {{{ nope\n");
      const evaluate = vi.fn();
      await expect(loadWorker(dir, evaluate)).rejects.toThrow();
      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  test("emits no workflow exports, the DevKit's two strings being gone", async () => {
    await withTempDir(async (dir) => {
      await writeAgentTs(dir, "no-workflows");
      await loadWorker(dir, async (code) => {
        expect(code).not.toContain("__aaiWorkflowCode");
        expect(code).not.toContain("__aaiStepCode");
        return fakeWorker("no-workflows");
      });
    });
  });
});
