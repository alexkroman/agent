// Copyright 2026 the AAI authors. MIT license.
/**
 * The template-contract harness, with the vitest spawn faked.
 *
 * What a unit test can reach here is everything except the live model run, and
 * that is most of the risk: the selection (which starter is held to which
 * contract), the overwrite (the agent must not supply its own contract), the
 * materialization, and the cleanup. The one part left is `vitest run` in a
 * child process, which needs a key and spends tokens.
 *
 * @module
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  CONTRACT_FILE,
  type ContractRunner,
  contractWorkspace,
  readContract,
  runTemplateContract,
  spawnCommand,
  templateNamed,
} from "./template-contract.ts";

const TEMPLATES_DIR = fileURLToPath(new URL("../../aai-templates/templates/", import.meta.url));

const scratches: string[] = [];
afterEach(async () => {
  for (const dir of scratches.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A scratch path that does not exist yet — `runTemplateContract` creates it. */
async function scratch(): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), "aai-contract-"));
  scratches.push(base);
  return path.join(base, "workspace");
}

/** A runner that records the directory it was handed and returns `code`. */
function fakeRunner(code: number, output = ""): ContractRunner & { dir: string | undefined } {
  const runner = async (dir: string) => {
    runner.dir = dir;
    return { code, output };
  };
  runner.dir = undefined as string | undefined;
  return runner;
}

describe("templateNamed", () => {
  test("reads the template a prompt names", () => {
    expect(templateNamed("Build a desk. Use the retail template as a starting point.")).toBe(
      "retail",
    );
  });

  test("trailing punctuation is not part of the name", () => {
    // `\S+` would otherwise carry the sentence's period into a directory name.
    expect(templateNamed("Use the night-owl template.")).toBe("night-owl");
    expect(templateNamed("Use the solo-rpg template, then extend it")).toBe("solo-rpg");
  });

  test("a prompt naming no template yields undefined", () => {
    expect(templateNamed("Build a pizza agent with a real cart")).toBeUndefined();
  });

  test("it agrees with every starter prompt that names a real template", async () => {
    // The floor under the selection: if this pattern stopped matching, every
    // contract would silently not run and the tier would still print green.
    const { STARTERS } = await import("aai-studio-client/starters");
    const named = Object.values(STARTERS)
      .flat()
      .map((s) => templateNamed(s.prompt))
      .filter((t): t is string => t !== undefined);
    expect(named.length).toBeGreaterThan(8);
    for (const template of named) {
      const dir = path.join(TEMPLATES_DIR, template);
      await expect(
        stat(dir).then((s) => s.isDirectory()),
        `starter names template "${template}", which is not a directory`,
      ).resolves.toBe(true);
    }
  });
});

describe("contractWorkspace", () => {
  test("the canonical contract REPLACES one the workspace already carries", () => {
    // `use_template` copies a template's files verbatim, eval file included, so
    // a generated workspace can arrive holding a contract the coding agent was
    // then free to edit. Trusting it would make the verdict the agent's own.
    const written = contractWorkspace(
      { "agent.ts": "x", [CONTRACT_FILE]: "expect(true).toBe(true)" },
      "CANONICAL",
    );
    expect(written[CONTRACT_FILE]).toBe("CANONICAL");
  });

  test("it carries the agent's files through and adds a vitest config", () => {
    const written = contractWorkspace({ "agent.ts": "x", "tools/a.ts": "y" }, "C");
    expect(written["agent.ts"]).toBe("x");
    expect(written["tools/a.ts"]).toBe("y");
    // The plugin is what serves `virtual:aai/agent`; without it the contract
    // fails to resolve its import and every case reads as a broken agent.
    expect(written["vitest.config.ts"]).toMatch(/aaiAgentPlugin/);
  });
});

describe("readContract", () => {
  test("reads a real template's shipped contract", async () => {
    const { source, note } = await readContract(TEMPLATES_DIR, "retail");
    expect(note).toBe("");
    expect(source).toMatch(/virtual:aai\/agent/);
  });

  test("a template with no contract is reported, not thrown", async () => {
    const { source, note } = await readContract(TEMPLATES_DIR, "no-such-template");
    expect(source).toBeUndefined();
    expect(note).toMatch(/no-such-template/);
  });
});

describe("runTemplateContract", () => {
  const base = { files: { "agent.ts": "export default {}" }, templatesDir: TEMPLATES_DIR };

  test("a prompt naming no template does not run and does not fail", async () => {
    // Six starters name none. Holding one to a contract it never asked for is
    // the over-specification failure this grader has been bitten by four times.
    const run = fakeRunner(1);
    const result = await runTemplateContract({
      ...base,
      prompt: "Build a pizza agent",
      scratchDir: await scratch(),
      run,
    });
    expect(result).toEqual({ ran: false, passed: true, note: "prompt names no template" });
    expect(run.dir).toBeUndefined();
  });

  test("a template that ships no contract does not run and does not fail", async () => {
    const run = fakeRunner(1);
    const result = await runTemplateContract({
      ...base,
      prompt: "Use the no-such-template template",
      scratchDir: await scratch(),
      run,
    });
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(true);
    expect(run.dir).toBeUndefined();
  });

  test("a green contract run passes", async () => {
    const result = await runTemplateContract({
      ...base,
      prompt: "Use the retail template",
      scratchDir: await scratch(),
      run: fakeRunner(0),
    });
    expect(result).toEqual({ ran: true, passed: true, note: "" });
  });

  test("a red contract run fails and keeps the output", async () => {
    const result = await runTemplateContract({
      ...base,
      prompt: "Use the retail template",
      scratchDir: await scratch(),
      run: fakeRunner(1, "AssertionError:  every  order tool must refuse"),
    });
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.note).toBe("AssertionError: every order tool must refuse");
  });

  test("the workspace and the canonical contract are on disk when the runner is called", async () => {
    let seen: Record<string, string> = {};
    const dir = await scratch();
    await runTemplateContract({
      files: { "agent.ts": "export default {}", "tools/find.ts": "export default {}" },
      templatesDir: TEMPLATES_DIR,
      prompt: "Use the retail template",
      scratchDir: dir,
      async run(at) {
        seen = {
          agent: await readFile(path.join(at, "agent.ts"), "utf-8"),
          tool: await readFile(path.join(at, "tools/find.ts"), "utf-8"),
          contract: await readFile(path.join(at, CONTRACT_FILE), "utf-8"),
        };
        return { code: 0, output: "" };
      },
    });
    expect(seen.agent).toBe("export default {}");
    // Nested paths are created, not silently dropped — a tool-less agent is the
    // failure mode `tool-registry.ts` exists to prevent.
    expect(seen.tool).toBe("export default {}");
    expect(seen.contract).toMatch(/virtual:aai\/agent/);
  });

  test("the scratch directory is removed afterwards", async () => {
    const dir = await scratch();
    await runTemplateContract({
      ...base,
      prompt: "Use the retail template",
      scratchDir: dir,
      run: fakeRunner(0),
    });
    await expect(stat(dir)).rejects.toThrow();
  });

  test("the scratch directory is removed even when the runner throws", async () => {
    // It lives INSIDE the repo so Node resolution finds the package's
    // node_modules, which is exactly why a leak is not harmless: `git status`,
    // `biome check` and `tsc` all walk into what is left behind.
    const dir = await scratch();
    await expect(
      runTemplateContract({
        ...base,
        prompt: "Use the retail template",
        scratchDir: dir,
        run: () => Promise.reject(new Error("vitest died")),
      }),
    ).rejects.toThrow(/vitest died/);
    await expect(stat(dir)).rejects.toThrow();
  });

  test("a scratch directory left by an earlier run is reused, not fatal", async () => {
    // The cleanup is best-effort (`.catch`), so a crashed run can leave one
    // behind. `mkdir { recursive: true }` is what makes that a non-event.
    const dir = await scratch();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "stale.ts"), "old", "utf-8");
    const result = await runTemplateContract({
      ...base,
      prompt: "Use the retail template",
      scratchDir: dir,
      run: fakeRunner(0),
    });
    expect(result.passed).toBe(true);
  });
});

describe("spawnCommand", () => {
  test("a green command reports code 0", async () => {
    const result = await spawnCommand("node", ["-e", ""], { env: {}, timeoutMs: 10_000 })(
      process.cwd(),
    );
    expect(result.code).toBe(0);
  });

  test("a non-zero exit is reported, not thrown", async () => {
    const result = await spawnCommand("node", ["-e", "process.exit(3)"], {
      env: {},
      timeoutMs: 10_000,
    })(process.cwd());
    expect(result.code).toBe(3);
  });

  test("BOTH streams are captured", async () => {
    // A vitest failure writes its assertion to stdout and its summary to
    // stderr; keeping one loses half the only diagnostic the note carries.
    const result = await spawnCommand(
      "node",
      ["-e", "process.stdout.write('OUT');process.stderr.write('ERR');process.exit(1)"],
      { env: {}, timeoutMs: 10_000 },
    )(process.cwd());
    expect(result.output).toContain("OUT");
    expect(result.output).toContain("ERR");
  });

  test("the child sees the env it was handed", async () => {
    const result = await spawnCommand(
      "node",
      ["-e", "process.stdout.write(process.env.AAI_X??'')"],
      {
        env: { AAI_X: "seen" },
        timeoutMs: 10_000,
      },
    )(process.cwd());
    expect(result.output).toContain("seen");
  });

  test("it runs in the directory it was given", async () => {
    const dir = await scratch();
    await mkdir(dir, { recursive: true });
    const result = await spawnCommand("node", ["-e", "process.stdout.write(process.cwd())"], {
      env: {},
      timeoutMs: 10_000,
    })(dir);
    // realpath, because macOS resolves /var to /private/var.
    expect(result.output).toContain(path.basename(dir));
  });

  test("a command that cannot start resolves as a failure", async () => {
    // Not a throw: a contract that could not run is a contract that did not
    // pass, and the reason belongs in the note beside the other failures.
    const result = await spawnCommand("aai-no-such-binary", [], { env: {}, timeoutMs: 10_000 })(
      process.cwd(),
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/ENOENT|not found|spawn/i);
  });

  test("a wedged child is killed and reported rather than hanging", async () => {
    const result = await spawnCommand("node", ["-e", "setTimeout(()=>{}, 60000)"], {
      env: {},
      timeoutMs: 250,
    })(process.cwd());
    expect(result.code).toBe(1);
  });
});
