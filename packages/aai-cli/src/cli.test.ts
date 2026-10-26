// Copyright 2025 the AAI authors. MIT license.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { type ArgsDef, renderUsage } from "citty";
import { execa } from "execa";
import { describe, expect } from "vitest";
import { findUnknownFlags } from "./_cli-common.ts";
import { HELP_SECTIONS, rootHelp } from "./_help.ts";
import { test } from "./_test-utils.ts";
import { bareAaiPublish, mainCommand } from "./cli.ts";

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
  return stripVTControlCharacters(s)
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

describe("aai --help is grouped", () => {
  /** Every subcommand `--help` lists: registered and not hidden. */
  async function visibleCommands(): Promise<string[]> {
    const subs = mainCommand.subCommands as Record<string, { meta?: { hidden?: boolean } }>;
    return Object.entries(subs)
      .filter(([, cmd]) => cmd.meta?.hidden !== true)
      .map(([name]) => name);
  }

  test("every visible subcommand sits in exactly one section", async () => {
    const placed = HELP_SECTIONS.flatMap((section) => section.commands);
    expect(new Set(placed)).toEqual(new Set(await visibleCommands()));
    expect(new Set(placed).size).toBe(placed.length);
    // A command no section names would land under "Other" — never shipped.
    expect(normalize(await rootHelp(mainCommand))).not.toContain("OTHER");
  });

  test("the real bin prints the grouped help", async ({ tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(["--help"], dir);
    expect(exitCode).toBe(0);
    expect(normalize(stdout)).toContain("STUDIO ROUND-TRIP");
    // `deploy` is hidden (in-guest Publish is its only caller).
    expect(normalize(stdout)).not.toMatch(/^\s+deploy\s/m);
  });
});

describe("kebab-case flags", () => {
  const argsOf = (name: string): ArgsDef =>
    (mainCommand.subCommands as Record<string, { args: ArgsDef }>)[name]?.args ?? {};

  test.each([
    ["build", "skip-tests", "--skipTests"],
    ["build", "skip-typecheck", "--skipTypecheck"],
    ["publish", "skip-typecheck", "--skipTypecheck"],
    ["deploy", "skip-typecheck", "--skipTypecheck"],
    ["deploy", "allow-preview-slug", "--allowPreviewSlug"],
  ])("%s declares --%s, and still accepts %s", (cmd, kebab, camel) => {
    const args = argsOf(cmd);
    expect(args).toHaveProperty(kebab);
    // The old spelling is undeclared (so `--help` shows only kebab-case) and
    // still parses — citty aliases it and the unknown-flag guard normalizes it.
    expect(findUnknownFlags([camel, `--${kebab}`], args)).toEqual([]);
  });
});

describe("cli usage snapshots", () => {
  test("aai --help", async () => {
    expect(normalize(await rootHelp(mainCommand))).toMatchSnapshot();
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
  test("a missing positional emits a JSON result, not a usage block", async ({ tmpDir: dir }) => {
    const { exitCode, stdout, stderr } = await runBin(["secret", "put"], dir);
    expect(exitCode).toBe(1);
    const parsed: unknown = JSON.parse(stdout.trim());
    expect(parsed).toMatchObject({ ok: false, code: "usage" });
    // The specific reason is still there for a human — on stderr, where it
    // does not corrupt the result line.
    expect(stderr).toContain("NAME");
  });

  test("an unknown subcommand emits a JSON result too", async ({ tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(["no-such-command"], dir);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false, code: "usage" });
  });

  // The sibling failure path, ten lines below `usageForMode` in cli.ts and
  // written without it: `assertKnownFlags` refuses a typo'd flag (so
  // `--serverr=…` cannot silently retarget the server), but it reported that
  // through clack — a human block on STDOUT and no JSON at all, which is the
  // exact contract break the tests above cover for citty's own usage block.
  test("an unknown option emits a JSON result, not a clack block", async ({ tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(["push", "--serverr=http://evil.test"], dir);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      ok: false,
      code: "usage",
      error: expect.stringContaining("--serverr"),
    });
  });

  test("--help is still the human usage block when piped", async ({ tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(["secret", "put", "--help"], dir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
    expect(() => JSON.parse(stdout.trim())).toThrow();
  });
});

describe("aai test's flags", () => {
  test("--only is accepted rather than refused as unknown", async ({ tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(["test", "--only"], dir);
    // It fails here, but on the agent gate — not on the flag.
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim()) as { code?: string; error?: string };
    expect(parsed.code).not.toBe("usage");
    expect(parsed.error).toContain("No agent.ts found");
  });
});

describe("aai test --all is gone", () => {
  test("is refused as an unknown flag — every spec already runs by default", async ({
    tmpDir: dir,
  }) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "agent.ts"), "export default {};\n");
    const { exitCode, stdout } = await runBin(["test", "--all"], dir);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false, code: "usage" });
  });
});

describe("aai test requires an agent project", () => {
  // It was the one project-scoped command calling `setup()` bare rather than
  // `setup({ agent: true })`. With no agent.ts it found no test file, reported
  // `{ passed: true, skipped: true }` and exited 0 — a green result for a
  // project that is not there, which in CI reads exactly like a passing suite.
  test("refuses a directory with no agent.ts instead of reporting success", async ({
    tmpDir: dir,
  }) => {
    const { exitCode, stdout } = await runBin(["test"], dir);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      ok: false,
      error: expect.stringContaining("No agent.ts found"),
    });
  });
});

/** A directory holding an agent.ts, as an agent-gated command needs. */
async function withAgent(dir: string): Promise<string> {
  await writeFile(path.join(dir, "agent.ts"), "export default {};\n");
  return dir;
}

describe("--version beside a command answers and runs nothing", () => {
  // citty answers `--version` only as the SOLE argument; elsewhere the built-in
  // flag passed the unknown-flag guard and was dropped, so `aai publish -v`
  // attempted a publish and `aai init --version` scaffolded a project.
  test.for([
    ["publish", "-v"],
    ["init", "--version"],
    ["dev", "--version"],
    ["secret", "put", "NAME", "-v"],
  ])("aai %j prints the version and exits 0", async (args, { tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(args, await withAgent(dir));
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      ok: true,
      data: { version: expect.stringMatching(/\d+\.\d+/) },
    });
    // Nothing was scaffolded, built or linked.
    expect(await readdir(dir)).toEqual(["agent.ts"]);
  });

  test("--help with a command still shows that command's usage", async ({ tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(["publish", "-h", "-v"], dir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  test("a built-in given a value is refused rather than ignored", async ({ tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(["publish", "--help=1"], dir);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false, code: "usage" });
  });
});

describe("--server is a URL or a usage error, never a silent fallback", () => {
  // Each of these used to send the API key to the DEFAULT origin.
  test.for([
    ["list", "--server="],
    ["list", "--server"],
    ["list", "--no-server"],
    ["list", "--server", "--json"],
    ["list", "-s="],
    ["list", "--server", "not a url"],
    ["list", "--server=ftp://x.test"],
  ])("aai %j", async (args, { tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(args, dir);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      ok: false,
      code: "usage",
      error: expect.stringMatching(/--server|-s/),
    });
  });

  test("--no-X is still fine for a switch", async ({ tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(["templates", "--no-json"], dir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("quickstart-agent");
  });
});

describe("extra positionals are a usage error naming them", () => {
  test("aai delete other-project does not act on the linked project", async ({ tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(["delete", "other-project"], dir);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      ok: false,
      code: "usage",
      error: expect.stringContaining("other-project"),
    });
  });

  test("aai dev x y z does not start", async ({ tmpDir: dir }) => {
    const { exitCode, stdout } = await runBin(["dev", "x", "y", "z"], await withAgent(dir));
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      code: "usage",
      error: expect.stringContaining("x y z"),
    });
  });

  test("a declared positional plus one more names only the extra", async ({ tmpDir: dir }) => {
    const { stdout } = await runBin(["workflow", "runs", "digest", "extra"], dir);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      code: "usage",
      error: "Unexpected argument: extra",
    });
  });
});

describe("strict numbers", () => {
  test.for(["0x10", "1e3", "0", ""])(
    "aai dev --port=%s is refused",
    async (port, { tmpDir: dir }) => {
      const { exitCode, stdout } = await runBin(["dev", `--port=${port}`], await withAgent(dir));
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        ok: false,
        code: "usage",
        error: expect.stringContaining("Invalid port"),
      });
    },
  );

  test("--limit -Infinity says the flag needs a value, not 'unknown option'", async ({
    tmpDir: dir,
  }) => {
    const { stdout } = await runBin(["workflow", "runs", "wf", "--limit", "-Infinity"], dir);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      code: "usage",
      error: expect.stringContaining("--limit needs a value"),
    });
  });
});

describe("`--` before a command", () => {
  test("is a clean usage error, with no stray citty line", async ({ tmpDir: dir }) => {
    const { exitCode, stdout, stderr } = await runBin(["--", "publish"], dir);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false, code: "usage" });
    expect(stderr).not.toContain("No command specified");
  });
});

describe("a closed stdout keeps the exit code the run owes", () => {
  /** Run the bin with its stdout pipe closed before it writes anything. */
  async function runClosed(args: string[], cwd: string) {
    const child = execa(process.execPath, [BIN, ...args], {
      cwd,
      reject: false,
      extendEnv: false,
      env: { PATH: process.env.PATH ?? "", HOME: cwd, AAI_CONFIG_DIR: path.join(cwd, ".config") },
    });
    child.stdout?.destroy();
    const result = await child;
    return { exitCode: result.exitCode, stderr: String(result.stderr) };
  }

  // EPIPE exited 0 whatever the result, so `aai list | <closed>` hid a failure
  // under `pipefail`.
  test("a failing command still exits 1", async ({ tmpDir: dir }) => {
    const { exitCode, stderr } = await runClosed(["list"], dir);
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("EPIPE");
  });

  test("--help and a succeeding command exit 0, quietly", async ({ tmpDir: dir }) => {
    for (const args of [["--help"], ["templates"]]) {
      const { exitCode, stderr } = await runClosed(args, dir);
      expect(exitCode, args.join(" ")).toBe(0);
      expect(stderr, args.join(" ")).not.toContain("Error");
    }
  });
});

describe("bare aai publishes only with a human's say-so", () => {
  test.each([
    [{ stdin: true, stdout: true }, "confirm"],
    // `aai | tee log` at a terminal: a human is there, with nowhere to confirm.
    [{ stdin: true, stdout: false }, "refuse"],
    [{ stdin: false, stdout: false }, "publish"],
    [{ stdin: false, stdout: true }, "publish"],
  ] as const)("%j → %s", (tty, action) => {
    expect(bareAaiPublish(tty)).toBe(action);
  });

  test("the help text says what a piped bare aai does", async () => {
    expect(normalize(await rootHelp(mainCommand))).toContain("with its output piped it refuses");
  });
});
