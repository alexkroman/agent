// Copyright 2025 the AAI authors. MIT license.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderUsage } from "citty";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { mainCommand } from "./cli.ts";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin.mjs");

/**
 * Run the real bin with stdout piped, which is also what puts it in JSON mode
 * — the auto-detection these two behaviours turn on cannot be reached by
 * calling the command bodies directly.
 */
async function runBin(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(process.execPath, [BIN, ...args], {
    cwd,
    reject: false,
    extendEnv: false,
    env: { PATH: process.env.PATH ?? "", HOME: cwd, AAI_CONFIG_DIR: path.join(cwd, ".config") },
  });
  return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
}

/** Strip ANSI escape codes and normalize the version string for stable snapshots. */
function normalize(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
  const ansi = /\x1b\[[0-9;]*m/g;
  return s
    .replace(ansi, "")
    .replace(/v\d+\.\d+\.\d+/g, "vX.X.X") // normalize version
    .replace(/\s+$/gm, ""); // strip trailing whitespace per line
}

describe("cli", () => {
  test.each(["init", "dev", "test", "eval", "build", "deploy", "delete", "secret"])(
    "main command declares the %s subcommand",
    (cmd) => {
      const subs = mainCommand.subCommands as Record<string, unknown>;
      expect(subs[cmd]).toBeDefined();
    },
  );

  test("main command meta has correct name", () => {
    const meta = mainCommand.meta as { name?: string; version?: string };
    expect(meta?.name).toBe("aai");
  });

  test("main command meta has version", () => {
    const meta = mainCommand.meta as { name?: string; version?: string };
    expect(meta?.version).toMatch(/\d+\.\d+/);
  });

  test("deploy subcommand has server arg", () => {
    const subs = mainCommand.subCommands as Record<string, { args?: Record<string, unknown> }>;
    const deployCmd = subs.deploy;
    expect(deployCmd?.args?.server).toBeDefined();
  });

  test("secret subcommand has nested subcommands", () => {
    const subs = mainCommand.subCommands as Record<
      string,
      { subCommands?: Record<string, unknown> }
    >;
    const secretCmd = subs.secret;
    expect(secretCmd?.subCommands?.put).toBeDefined();
    expect(secretCmd?.subCommands?.delete).toBeDefined();
    expect(secretCmd?.subCommands?.list).toBeDefined();
  });

  test("declares no storage subcommand — the platform provisions no databases", () => {
    // `aai storage enable` provisioned a per-app Postgres and handed the guest a
    // `DATABASE_URL`. There is no such thing to switch on now: a database is a
    // secret the author points at their own provider. Asserted as an ABSENCE
    // because the removal is the user-visible part of that change.
    expect((mainCommand.subCommands as Record<string, unknown>).storage).toBeUndefined();
  });

  /**
   * The absence above was asserted and the GUIDES still named `storage` for
   * every release after it was removed — this package's `CLAUDE.md` in its
   * opening `Binary: aai — subcommands: …` line, and the root `AGENTS.md` in
   * its package table. A user reading either got a subcommand that prints the
   * top-level help and exits 1.
   *
   * So the sentence is pinned to the registry rather than hand-kept. `deploy`
   * is excluded because it is deliberately undocumented (in-guest Publish is
   * its only caller), which is the one asymmetry the list is allowed.
   */
  test("the subcommand list in this package's guide names exactly what cli.ts registers", async () => {
    const guide = await readFile(path.join(import.meta.dirname, "../CLAUDE.md"), "utf-8");
    const line = /Binary: `aai` — subcommands: ([^.]+)\./.exec(guide);
    expect(line?.[1], "guide is missing its `Binary: aai — subcommands: …` line").toBeDefined();
    const documented = (line?.[1] ?? "").split(/,\s*/).map((s) => s.trim());
    const registered = Object.keys(mainCommand.subCommands as Record<string, unknown>).filter(
      (name) => name !== "deploy",
    );
    expect([...documented].sort()).toEqual([...registered].sort());
  });
});

describe("cli usage snapshots", () => {
  test("aai --help", async () => {
    const usage = await renderUsage(mainCommand);
    expect(normalize(usage)).toMatchSnapshot();
  });

  // Cast is safe — we control the command names.
  const sub = (name: string) =>
    (mainCommand.subCommands as Record<string, Parameters<typeof renderUsage>[0]>)[
      name
    ] as Parameters<typeof renderUsage>[0];

  test.each(["init", "dev", "test", "eval", "build", "deploy", "delete"])(
    "aai %s --help",
    async (name) => {
      const usage = await renderUsage(sub(name));
      expect(normalize(usage)).toMatchSnapshot();
    },
  );

  test("aai secret --help", async () => {
    const usage = await renderUsage(sub("secret"));
    expect(normalize(usage)).toMatchSnapshot();
  });

  const secretSub = (name: string) =>
    (sub("secret") as { subCommands: Record<string, Parameters<typeof renderUsage>[0]> })
      .subCommands[name] as Parameters<typeof renderUsage>[0];

  test.each(["put", "delete", "list"])("aai secret %s --help", async (name) => {
    const usage = await renderUsage(secretSub(name));
    expect(normalize(usage)).toMatchSnapshot();
  });
});

describe("JSON mode keeps stdout to one result line", () => {
  // citty writes its usage block to STDOUT from the same `catch` that handles
  // a missing positional or an unknown subcommand, so `aai secret put --json`
  // put a usage block where a script's parser expected a result and emitted
  // no JSON at all. JSON mode is auto-detected on a pipe, so this is the
  // normal scripted case rather than an opt-in one.
  test("a missing positional emits a JSON result, not a usage block", async () => {
    await withTempDir(async (dir) => {
      const { exitCode, stdout, stderr } = await runBin(["secret", "put"], dir);
      expect(exitCode).toBe(1);
      const parsed: unknown = JSON.parse(stdout.trim());
      expect(parsed).toMatchObject({ ok: false, code: "usage" });
      // The specific reason is still there for a human — on stderr, where it
      // does not corrupt the result line.
      expect(stderr).toContain("NAME");
    });
  });

  test("an unknown subcommand emits a JSON result too", async () => {
    await withTempDir(async (dir) => {
      const { exitCode, stdout } = await runBin(["no-such-command"], dir);
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false, code: "usage" });
    });
  });

  // The sibling failure path, ten lines below `usageForMode` in cli.ts and
  // written without it: `assertKnownFlags` refuses a typo'd flag (so
  // `--serverr=…` cannot silently retarget the server), but it reported that
  // through clack — a human block on STDOUT and no JSON at all, which is the
  // exact contract break the tests above cover for citty's own usage block.
  test("an unknown option emits a JSON result, not a clack block", async () => {
    await withTempDir(async (dir) => {
      const { exitCode, stdout } = await runBin(["push", "--serverr=http://evil.test"], dir);
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        ok: false,
        code: "usage",
        error: expect.stringContaining("--serverr"),
      });
    });
  });

  test("--help is still the human usage block when piped", async () => {
    await withTempDir(async (dir) => {
      const { exitCode, stdout } = await runBin(["secret", "put", "--help"], dir);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("USAGE");
      expect(() => JSON.parse(stdout.trim())).toThrow();
    });
  });
});

describe("aai test requires an agent project", () => {
  // It was the one project-scoped command calling `setup()` bare rather than
  // `setup({ agent: true })`. With no agent.ts it found no test file, reported
  // `{ passed: true, skipped: true }` and exited 0 — a green result for a
  // project that is not there, which in CI reads exactly like a passing suite.
  test("refuses a directory with no agent.ts instead of reporting success", async () => {
    await withTempDir(async (dir) => {
      const { exitCode, stdout } = await runBin(["test"], dir);
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        ok: false,
        error: expect.stringContaining("No agent.ts found"),
      });
    });
  });
});
