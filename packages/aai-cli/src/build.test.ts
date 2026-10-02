// Copyright 2025 the AAI authors. MIT license.
// `aai build` (build.ts): the build result, the worker artifact `aai start`
// boots, and the deploy-env warnings. The bundle itself is `_bundler.test.ts`.
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect } from "vitest";
import { linkSdkNodeModules, test } from "./_test-utils.ts";
// `missingDeployEnv` imports this lazily (it pulls the SDK runtime barrel).
// Loading it at collection keeps that cold import out of whichever config
// test runs first, where it alone could exceed the 5s unit-tier budget.
import "./_preflight.ts";
import {
  executeBuild,
  missingDeployEnv,
  missingEnvWarnings,
  WORKER_ARTIFACT_REL,
} from "./build.ts";

describe("executeBuild", () => {
  test("returns the agent name and worker size", { timeout: 120_000 }, async ({ tmpDir: dir }) => {
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
  });

  test("leaves the built worker on disk, importable, where `aai start` looks for it", {
    timeout: 120_000,
  }, async ({ tmpDir: dir }) => {
    // The self-hosting contract: `npm start` runs `aai build` and then
    // imports this exact path. The scaffold's `server.mjs` hardcodes it (it
    // cannot import from the CLI), so nothing but a test holds the two ends
    // together in-tree — the `npm start` leg of e2e.test.ts is the only tier
    // that runs both as a user does.
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
  }, async ({ tmpDir: dir }) => {
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
  });

  test("names agent.ts when the prompt is declared there", { timeout: 120_000 }, async ({
    tmpDir: dir,
  }) => {
    await linkSdkNodeModules(dir);
    await writeFile(
      path.join(dir, "agent.ts"),
      `import { agent } from "@alexkroman1/aai";\nexport default agent({ name: "inline", systemPrompt: "Be brief." });`,
    );
    const result = await executeBuild({ cwd: dir, skipTests: true, skipTypecheck: true });
    expect(result.ok && result.data.systemPrompt).toBe("agent.ts");
  });
});

describe("missingDeployEnv", () => {
  test("reports a variable the declaration names and the host has no value for", async ({
    tmpDir: dir,
  }) => {
    await writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
    expect(await missingDeployEnv(dir, "vercel", {})).toEqual(["ASSEMBLYAI_API_KEY"]);
  });

  test("a value in .env does NOT suppress it — .env never reaches the deployment", async ({
    tmpDir: dir,
  }) => {
    // The case this check exists for, and the one a `resolveServerEnv`-based
    // implementation gets wrong. `.env` IS uploaded into a host's build
    // workspace (Vercel filters uploads by `.vercelignore`, not by
    // `.gitignore`'s contents) and is deliberately absent from the deployment
    // artifact — `RUNTIME_FILES` in `_vercel-output.ts`, where shipping it was
    // a credential leak. So a resolver would find this key, report nothing,
    // and the deployed function would still see no value.
    await writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
    await writeFile(path.join(dir, ".env"), "ASSEMBLYAI_API_KEY=a-real-local-key\n");
    expect(await missingDeployEnv(dir, "vercel", {})).toEqual(["ASSEMBLYAI_API_KEY"]);
  });

  test("stays quiet for the node target, which deploys nowhere", async ({ tmpDir: dir }) => {
    // `aai start` reads `.env` at boot and a provider credential still arrives
    // through `withHostCredentialFallback`, so a blank declaration is a
    // developer mid-setup. Warning here would fire on every local build.
    await writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
    expect(await missingDeployEnv(dir, "node", {})).toEqual([]);
  });

  test("a value on the host clears it, and an empty string does not", async ({ tmpDir: dir }) => {
    await writeFile(path.join(dir, ".env.example"), "SET_KEY=\nBLANK_KEY=\n");
    expect(await missingDeployEnv(dir, "vercel", { SET_KEY: "v", BLANK_KEY: "" })).toEqual([
      "BLANK_KEY",
    ]);
  });

  test("declares nothing when the project has no .env.example", async ({ tmpDir: dir }) => {
    expect(await missingDeployEnv(dir, "vercel", {})).toEqual([]);
  });

  test("names a requiredEnv key with no .env.example entry behind it", async ({ tmpDir: dir }) => {
    // The bug: `anywhere.md` promised "list what your tools read in
    // `requiredEnv` … the build warns by name about anything the deployment
    // will be missing", and this path derived from `.env.example` ALONE. So an
    // agent declaring ORDERS_API_KEY and nothing else got neither the warning
    // nor the `env add` step the printed `perSecret` sequence expands from this
    // same list — while the managed path (`_preflight.ts`) saw both sources.
    expect(
      await missingDeployEnv(
        dir,
        "vercel",
        {},
        {
          mode: "workflow-app",
          requiredEnv: ["ORDERS_API_KEY"],
        },
      ),
    ).toEqual(["ORDERS_API_KEY"]);
  });

  test("names a provider credential the normalized config implies", async ({ tmpDir: dir }) => {
    // Derived from the descriptors rather than declared anywhere by the author,
    // which is why the config has to be the NORMALIZED one (`__aaiConfig`) and
    // not the raw def — see `_preflight.ts`.
    expect(
      await missingDeployEnv(dir, "vercel", {}, { llm: { kind: "anthropic", options: {} } }),
    ).toContain("ANTHROPIC_API_KEY");
  });

  test("unions the two sources and de-duplicates a name in both", async ({ tmpDir: dir }) => {
    await writeFile(path.join(dir, ".env.example"), "FROM_EXAMPLE=\nIN_BOTH=\n");
    expect(
      await missingDeployEnv(
        dir,
        "vercel",
        {},
        {
          mode: "workflow-app",
          requiredEnv: ["IN_BOTH", "FROM_CONFIG"],
        },
      ),
    ).toEqual(["FROM_EXAMPLE", "IN_BOTH", "FROM_CONFIG"]);
  });

  test("a host value clears a config-derived name exactly as it clears a declared one", async ({
    tmpDir: dir,
  }) => {
    expect(
      await missingDeployEnv(
        dir,
        "vercel",
        { ORDERS_API_KEY: "v" },
        { mode: "workflow-app", requiredEnv: ["ORDERS_API_KEY"] },
      ),
    ).toEqual([]);
  });

  test("stays quiet for the node target even with a config in hand", async ({ tmpDir: dir }) => {
    // The early return is what makes `build.ts` skip the second bundle
    // evaluation on every ordinary local build, so it must not be reachable
    // past the config argument.
    expect(
      await missingDeployEnv(
        dir,
        "node",
        {},
        { mode: "workflow-app", requiredEnv: ["ORDERS_API_KEY"] },
      ),
    ).toEqual([]);
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
