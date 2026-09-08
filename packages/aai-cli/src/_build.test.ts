// Copyright 2025 the AAI authors. MIT license.
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { buildAgentBundle, evalWorkerBundle } from "./_bundler.ts";
import { linkSdkNodeModules, silenced, withTempDir } from "./_test-utils.ts";
import {
  executeBuild,
  missingDeployEnv,
  missingEnvWarnings,
  WORKER_ARTIFACT_REL,
} from "./build.ts";

/** Import a built worker and return its `__aaiConfig` self-description. */
async function extractConfig(worker: string): Promise<Record<string, unknown>> {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(worker).toString("base64")}`);
  return mod.__aaiConfig as Record<string, unknown>;
}

/**
 * Most cases below pass `runtime: false`: they assert config self-description
 * and bundle shape, which are orthogonal to the runtime, and inlining the
 * runtime + provider SDKs takes ~10s per build. The deploy-shaped build
 * (runtime included) is covered by the dedicated "ships its runtime" test
 * and `executeBuild`, each with an explicit timeout.
 */
describe("buildAgentBundle", () => {
  test("throws when no agent.ts found", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      await expect(silenced(() => buildAgentBundle(dir))(dir)).rejects.toThrow("agent.ts");
    });
  });

  test("bundles minimal agent with a self-describing config export", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "build-test-agent", systemPrompt: "Test prompt", greeting: "Hello", maxSteps: 5, tools: {} };`,
        );
        const bundle = await buildAgentBundle(dir, { runtime: false });
        const config = await extractConfig(bundle.worker);
        expect(config.name).toBe("build-test-agent");
        expect(config.systemPrompt).toBe("Test prompt");
        expect(config.greeting).toBe("Hello");
        expect(config.maxSteps).toBe(5);
        expect(config.toolSchemas).toEqual([]);
        expect(bundle.worker).toContain("export");
        expect(bundle.clientFiles).toEqual({});
      }),
    );
  });

  test("bundles agent with tools and self-describes their schemas", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `
import { z } from "zod";

const greetTool = {
  description: "Greet someone by name",
  inputSchema: z.object({ name: z.string() }),
  execute: ({ name }) => "Hello, " + name,
};

export default {
  name: "tool-test-agent",
  systemPrompt: "Test",
  greeting: "Hi",
  maxSteps: 5,
  tools: { greet: greetTool },
};
`,
        );
        const bundle = await buildAgentBundle(dir, { runtime: false });
        const config = await extractConfig(bundle.worker);
        expect(config.name).toBe("tool-test-agent");
        expect(config.toolSchemas).toEqual([
          {
            type: "function",
            name: "greet",
            description: "Greet someone by name",
            parameters: expect.objectContaining({ type: "object" }),
          },
        ]);
        // Worker should contain the tool code
        expect(bundle.worker).toContain("greet");
        expect(bundle.worker.length).toBeGreaterThan(50);
      }),
    );
  });

  test("minify option produces a smaller worker that still evaluates", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `const longDescriptiveVariableName = "Test prompt";
export default { name: "minify-test-agent", systemPrompt: longDescriptiveVariableName, greeting: "Hello", maxSteps: 5, tools: {} };`,
        );
        const plain = await buildAgentBundle(dir, { runtime: false });
        const minified = await buildAgentBundle(dir, { minify: true, runtime: false });
        // Minified bundle still evaluates to the same agent config.
        const config = await extractConfig(minified.worker);
        expect(config.name).toBe("minify-test-agent");
        expect(config.systemPrompt).toBe("Test prompt");
        // And it is no larger than the unminified build.
        expect(minified.worker.length).toBeLessThanOrEqual(plain.worker.length);
      }),
    );
  });

  test("Vite-bundled worker is valid ESM with default export", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "vite-test", systemPrompt: "Test", greeting: "Hi", maxSteps: 5, tools: {} };`,
        );
        const bundle = await buildAgentBundle(dir, { runtime: false });
        // Worker must be valid ESM — check for export syntax
        expect(bundle.worker).toMatch(/export/);
        // Must be a non-trivial bundle
        expect(bundle.worker.length).toBeGreaterThan(20);
      }),
    );
  });
});

describe("deploy-shaped build (runtime included)", () => {
  test("ships a working __aaiCreateRuntime factory", { timeout: 120_000 }, async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "runtime-ship", systemPrompt: "Test", greeting: "Hi", tools: {} };`,
        );
        const bundle = await buildAgentBundle(dir);
        // Evaluate exactly as the guest harness does: a real file import
        // (the bundled runtime's CJS interop rejects data: URLs).
        const agentDef = await evalWorkerBundle(bundle.worker);
        expect(agentDef.name).toBe("runtime-ship");

        const workerPath = path.join(dir, "worker-under-test.mjs");
        await writeFile(workerPath, bundle.worker, "utf-8");
        const mod = await import(pathToFileURL(workerPath).href);
        const factory = mod.__aaiCreateRuntime as (opts: Record<string, unknown>) => {
          startSession: unknown;
          shutdown: () => Promise<void>;
        };
        expect(typeof factory).toBe("function");
        // The factory builds a real runtime from the BUNDLED SDK — the
        // harness↔bundle contract: { env, db?, runCode? } in,
        // { startSession, shutdown } out.
        const runtime = factory({ env: { ASSEMBLYAI_API_KEY: "test-key" } });
        expect(typeof runtime.startSession).toBe("function");
        await runtime.shutdown();
      }),
    );
  });
});

describe("executeBuild", () => {
  test("returns the agent name and worker size", { timeout: 120_000 }, async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "exec-build", systemPrompt: "Test", greeting: "Hi", tools: {} };`,
        );
        // Skip the gates — this test covers the bundle+eval step, and the
        // temp project has no test file or tsconfig anyway.
        const result = await executeBuild({ cwd: dir, skipTests: true, skipTypecheck: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.data.name).toBe("exec-build");
          expect(result.data.workerBytes).toBeGreaterThan(20);
        }
      }),
    );
  });

  test("leaves the built worker on disk, importable, where `aai start` looks for it", {
    timeout: 120_000,
  }, async () => {
    // The self-hosting contract: `npm start` runs `aai build` and then
    // imports this exact path. The scaffold's `server.mjs` hardcodes it (it
    // cannot import from the CLI), so nothing but a test holds the two ends
    // together in-tree — the `npm start` leg of e2e.test.ts is the only tier
    // that runs both as a user does.
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "on-disk", systemPrompt: "Test", greeting: "Hi", tools: {} };`,
        );

        const result = await executeBuild({ cwd: dir, skipTests: true, skipTypecheck: true });

        const written = path.join(dir, WORKER_ARTIFACT_REL);
        expect(result.ok && result.data.worker).toBe(written);
        // Importable, not merely present: this is the module `npm start`
        // boots, and its default export is the agent with its tools already
        // attached by the generated entry.
        const mod = await import(pathToFileURL(written).href);
        expect((mod.default as { name: string }).name).toBe("on-disk");
      }),
    );
  });
});

describe("executeBuild reports WHICH prompt shipped", () => {
  // Deleting `system-prompt.md` swaps in DEFAULT_SYSTEM_PROMPT — a total
  // personality change — with exit 0 and, before this, nothing in the result
  // saying so. `withSystemPrompt` cannot refuse it: an agent with no file is
  // what a project with no file legitimately looks like. So the build REPORTS
  // the source instead. This spec is also what pins `build.ts`'s copy of the
  // file name against `worker-bundler.ts`'s, the two being unshareable.
  test("names the file, then the framework default once it is gone", {
    timeout: 240_000,
  }, async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "prompt-source" });`,
        );
        await writeFile(path.join(dir, "system-prompt.md"), "You are a pirate. Always say arrr.\n");

        const withFile = await executeBuild({ cwd: dir, skipTests: true, skipTypecheck: true });
        expect(withFile.ok && withFile.data.systemPrompt).toBe("system-prompt.md");

        await rm(path.join(dir, "system-prompt.md"));
        const without = await executeBuild({ cwd: dir, skipTests: true, skipTypecheck: true });
        expect(without.ok && without.data.systemPrompt).toContain("framework default");
      }),
    );
  });

  test("names agent.ts when the prompt is declared there", { timeout: 120_000 }, async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "inline", systemPrompt: "Be brief." });`,
        );
        const result = await executeBuild({ cwd: dir, skipTests: true, skipTypecheck: true });
        expect(result.ok && result.data.systemPrompt).toBe("agent.ts");
      }),
    );
  });
});

describe("evalWorkerBundle", () => {
  // An explicit budget, like the two bundling specs above: this writes a temp
  // module and imports it, which is fast alone and not when the rest of this
  // file's Vite builds are running beside it. At the default 5s it was the one
  // test in the repo that failed under load and passed on a rerun — a flake
  // that reads as a broken change to whatever happens to be in flight.
  test("evaluates a worker bundle without touching the filesystem", {
    timeout: 30_000,
  }, async () => {
    const agent = await evalWorkerBundle(
      `export default { name: "evaled", systemPrompt: "p", greeting: "g", tools: {} };`,
    );
    expect(agent.name).toBe("evaled");
  });
});

describe("missingDeployEnv", () => {
  test("reports a variable the declaration names and the host has no value for", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
      expect(await missingDeployEnv(dir, "vercel", {})).toEqual(["ASSEMBLYAI_API_KEY"]);
    });
  });

  test("a value in .env does NOT suppress it — .env never reaches the deployment", async () => {
    // The case this check exists for, and the one a `resolveServerEnv`-based
    // implementation gets wrong. `.env` IS uploaded into a host's build
    // workspace (Vercel filters uploads by `.vercelignore`, not by
    // `.gitignore`'s contents) and is deliberately absent from the deployment
    // artifact — `RUNTIME_FILES` in `_vercel-output.ts`, where shipping it was
    // a credential leak. So a resolver would find this key, report nothing,
    // and the deployed function would still see no value.
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
      await writeFile(path.join(dir, ".env"), "ASSEMBLYAI_API_KEY=a-real-local-key\n");
      expect(await missingDeployEnv(dir, "vercel", {})).toEqual(["ASSEMBLYAI_API_KEY"]);
    });
  });

  test("stays quiet for the node target, which deploys nowhere", async () => {
    // `aai start` reads `.env` at boot and a provider credential still arrives
    // through `withHostCredentialFallback`, so a blank declaration is a
    // developer mid-setup. Warning here would fire on every local build.
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
      expect(await missingDeployEnv(dir, "node", {})).toEqual([]);
    });
  });

  test("a value on the host clears it, and an empty string does not", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, ".env.example"), "SET_KEY=\nBLANK_KEY=\n");
      expect(await missingDeployEnv(dir, "vercel", { SET_KEY: "v", BLANK_KEY: "" })).toEqual([
        "BLANK_KEY",
      ]);
    });
  });

  test("declares nothing when the project has no .env.example", async () => {
    await withTempDir(async (dir) => {
      expect(await missingDeployEnv(dir, "vercel", {})).toEqual([]);
    });
  });
});

describe("missingEnvWarnings", () => {
  test("names the command that sets it, with the variable substituted", () => {
    const [warning] = missingEnvWarnings(["ASSEMBLYAI_API_KEY"], "vercel", "Agent");
    expect(warning).toContain("vercel env add ASSEMBLYAI_API_KEY production");
    // The redeploy half: a host captured its variable set for the deployment
    // that already went out, so setting the value alone changes nothing.
    expect(warning).toContain("deploy again");
  });

  test("names deno's and modal's commands too, which it could not before", () => {
    // This test asserted the OPPOSITE: that `modal` "knows no command", so the
    // warning named the environment and nothing to run. That was true of
    // `TargetOutput.secret`, absent for both of these hosts on the grounds
    // that their commands were unverified — and they are the two whose secret
    // command a reader is least likely to guess. Both are verified now.
    const [deno] = missingEnvWarnings(["ASSEMBLYAI_API_KEY"], "deno", "Agent");
    expect(deno).toContain("deno deploy env add ASSEMBLYAI_API_KEY");

    const [modal] = missingEnvWarnings(["ASSEMBLYAI_API_KEY"], "modal", "Quickstart Assistant");
    expect(modal).toContain("modal secret create quickstart-assistant-env ASSEMBLYAI_API_KEY=");
  });

  test("resolves Modal's secret name from the AGENT, not a placeholder", () => {
    // The warning reads off the resolved sequence, so it cannot print a
    // literal `<secret>` beside a step showing the real name.
    const [warning] = missingEnvWarnings(["ASSEMBLYAI_API_KEY"], "modal", "Retail Support Bot");
    expect(warning).toContain("retail-support-bot-env");
    expect(warning).not.toContain("<secret>");
  });

  test("names the environment where the target really knows no command", () => {
    // `node` is the one that genuinely has none: the deployment is a process
    // someone starts, which reads `.env` at boot. In practice it never reaches
    // here — `missingDeployEnv` returns nothing for a target with no output
    // directory — so this pins the FALLBACK branch, which is the only thing
    // standing between a future target with no secret command and a crash.
    const [warning] = missingEnvWarnings(["A"], "node", "Agent");
    expect(warning).toContain("Set it in the node environment");
  });

  test("one sentence per variable", () => {
    expect(missingEnvWarnings(["A", "B"], "vercel", "Agent")).toHaveLength(2);
  });
});
