// Copyright 2026 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { type ArgsDef, type CommandDef, runCommand as runCittyCommand } from "citty";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { CliError, fail, ok } from "./_output.ts";
import { withTempDir } from "./_test-utils.ts";

const logMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
}));
const silenceOutput = vi.hoisted(() => vi.fn());
vi.mock("./_ui.ts", () => ({ log: logMock, silenceOutput }));

const { defineExec, findUnknownFlags, resolveArgv, runCommand, setup, sharedArgs } = await import(
  "./_cli-common.ts"
);

// `logMock` and `silenceOutput` are module-level `vi.fn()`s, and
// `restoreMocks: true` registers only `vi.spyOn` mocks — it clears none of
// their call history. File-scope rather than inside one describe: an
// `expect(logMock.error).toHaveBeenCalledWith(…)` in the `defineExec` block is
// otherwise satisfiable by a `runCommand` case that logged the same sentence.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("findUnknownFlags", () => {
  const argsDef = {
    server: { type: "string", alias: "s" },
    force: { type: "boolean", alias: "f" },
    json: { type: "boolean" },
    allowPreviewSlug: { type: "boolean" },
    dir: { type: "positional", required: false },
  } as const;

  test("accepts the kebab-case spelling of a camelCase flag", () => {
    // citty accepts both, and the guest's in-sandbox Publish spawns
    // `aai deploy --allow-preview-slug`. Matching only the camelCase name
    // broke Publish outright.
    expect(findUnknownFlags(["--allow-preview-slug"], argsDef)).toEqual([]);
    expect(findUnknownFlags(["--allowPreviewSlug"], argsDef)).toEqual([]);
    expect(findUnknownFlags(["--no-allow-preview-slug"], argsDef)).toEqual([]);
  });

  test("accepts declared flags, aliases, `=` forms, and negations", () => {
    expect(
      findUnknownFlags(
        ["--server", "https://x.test", "-f", "--json=false", "--no-force", "somedir"],
        argsDef,
      ),
    ).toEqual([]);
  });

  test("accepts the built-in help and version flags", () => {
    expect(findUnknownFlags(["--help", "-h", "--version", "-v"], argsDef)).toEqual([]);
  });

  test("reports a mistyped flag", () => {
    // The motivating case: `--serverr` was silently dropped and the command
    // then ran against the DEFAULT server — production, for an installed CLI —
    // while exiting 0 as though the flag had been honoured.
    expect(findUnknownFlags(["--serverr=http://evil.test"], argsDef)).toEqual(["--serverr"]);
    expect(findUnknownFlags(["--bogus"], argsDef)).toEqual(["--bogus"]);
  });

  test("stops interpreting flags after a bare `--`", () => {
    expect(findUnknownFlags(["--", "--not-a-flag"], argsDef)).toEqual([]);
  });

  test("leaves negative numbers and lone dashes alone", () => {
    expect(findUnknownFlags(["-", "-42"], argsDef)).toEqual([]);
  });
});

describe("unknown flags, resolved against the real command tree", () => {
  // Resolved against the REAL command tree, so the check can't drift from the
  // flags the commands actually declare — which means importing cli.ts and,
  // with it, every subcommand module it registers.
  //
  // Imported ONCE, in a hook: `await import("./cli.ts")` inside a test looks
  // free (~30ms once vite-node has the graph cached) and is anything but on
  // the first call — transforming that graph is charged to whichever test
  // gets there first, and under a saturated full-repo run that alone timed
  // out this test at the 5s default while it was doing nothing slow. A hook
  // makes the cost belong to the suite instead of to an arbitrary test, and
  // the raised budget below covers the rest.
  let mainCommand: Awaited<typeof import("./cli.ts")>["mainCommand"];
  beforeAll(async () => {
    ({ mainCommand } = await import("./cli.ts"));
  }, 60_000);

  /**
   * The same two calls `cli.ts`'s `assertKnownArgv` makes, in the same order —
   * so this exercises the shipped composition rather than a wrapper only the
   * spec used. A mistyped SUBCOMMAND reports no flags: they would be matched
   * against the wrong command's `argsDef`, and `unknownCommand` is what names
   * that case.
   */
  const unknownFlagsForArgv = async (
    root: Parameters<typeof resolveArgv>[0],
    argv: string[],
  ): Promise<string[]> => {
    const { unknownCommand, argsDef, rest } = await resolveArgv(root, argv);
    return unknownCommand === undefined ? findUnknownFlags(rest, argsDef) : [];
  };

  test("accepts every flag a command declares", async () => {
    expect(
      await unknownFlagsForArgv(mainCommand, ["push", "--server", "http://x", "--force"]),
    ).toEqual([]);
    expect(
      await unknownFlagsForArgv(mainCommand, ["publish", "--skipTypecheck", "--json"]),
    ).toEqual([]);
    expect(await unknownFlagsForArgv(mainCommand, ["init", "-t", "simple", "-y"])).toEqual([]);
  });

  test("descends into nested subcommands", async () => {
    expect(
      await unknownFlagsForArgv(mainCommand, ["secret", "put", "NAME", "-s", "http://x"]),
    ).toEqual([]);
    // `--force` belongs to `storage disable`, not to `secret put`.
    expect(await unknownFlagsForArgv(mainCommand, ["storage", "disable", "--force"])).toEqual([]);
    expect(await unknownFlagsForArgv(mainCommand, ["secret", "put", "NAME", "--force"])).toEqual([
      "--force",
    ]);
  });

  test("catches a mistyped --server before the command runs", async () => {
    expect(await unknownFlagsForArgv(mainCommand, ["push", "--serverr=http://evil.test"])).toEqual([
      "--serverr",
    ]);
  });

  test("accepts the exact argv the guest's in-sandbox Publish spawns", async () => {
    // aai-guest/studio-publish.ts runs the real CLI with these flags. Getting
    // this wrong breaks Publish for every studio user, and no unit test of the
    // flag matcher alone would have noticed — the spelling is kebab-case while
    // the args are declared camelCase.
    expect(
      await unknownFlagsForArgv(mainCommand, [
        "deploy",
        "--server",
        "http://x",
        "--json",
        "--allow-preview-slug",
      ]),
    ).toEqual([]);
  });

  test("says nothing about an unknown SUBCOMMAND — citty shows usage for that", async () => {
    expect(await unknownFlagsForArgv(mainCommand, ["puhs", "--server", "http://x"])).toEqual([]);
  });
});

describe("setup", () => {
  test("resolves the cwd; requires agent.ts only when asked", async () => {
    await withTempDir(async (dir) => {
      vi.stubEnv("INIT_CWD", dir);
      // No agent.ts: plain setup passes, agent-gated setup refuses.
      expect(await setup()).toBe(dir);
      await expect(setup({ agent: true })).rejects.toThrow("No agent.ts found");
      await fs.writeFile(path.join(dir, "agent.ts"), "export {};");
      expect(await setup({ agent: true })).toBe(dir);
    });
  });
});

describe("runCommand", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((_chunk, cb?: unknown) => {
      if (typeof cb === "function") (cb as () => void)();
      return true;
    });
  });

  test("human mode: success runs the body without exiting", async () => {
    const body = vi.fn().mockResolvedValue(ok({ fine: true }));
    await runCommand({ json: false }, body);
    expect(body).toHaveBeenCalledWith("human");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(silenceOutput).not.toHaveBeenCalled();
  });

  test("human mode: a thrown CliError logs the message AND the hint, exits 1", async () => {
    await runCommand({ json: false }, async () => {
      throw new CliError("bad_thing", "It broke", "Try the other thing");
    });
    expect(logMock.error).toHaveBeenCalledWith("It broke");
    // The hint is the recovery step — it must reach the terminal.
    expect(logMock.info).toHaveBeenCalledWith("Try the other thing");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("human mode: a plain Error gets the generic failure code", async () => {
    await runCommand({ json: false }, async () => {
      throw new Error("boom");
    });
    expect(logMock.error).toHaveBeenCalledWith("boom");
    expect(logMock.info).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("json mode: silences logs and writes exactly one result line", async () => {
    await runCommand({ json: true }, async () => ok({ n: 1 }));
    expect(silenceOutput).toHaveBeenCalled();
    const written = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(JSON.parse(written.trim())).toEqual({ ok: true, data: { n: 1 } });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("human mode: a RETURNED failure logs the message AND the hint, exits 1", async () => {
    // The convergence this module's doc promises used to hold only for the
    // `catch` arm: a body that RETURNED `fail(...)` fell straight through to
    // the JSON check and `process.exit(1)`, so nine subcommands — `aai test`
    // with no runner binary, all four `aai workflow` verbs against a booting
    // sandbox, `aai secret put` with an empty value, `aai storage disable`
    // without `--force` — exited 1 with an EMPTY terminal.
    await runCommand({ json: false }, async () =>
      fail("confirmation_required", "That would drop your data", "Re-run with --force"),
    );
    expect(logMock.error).toHaveBeenCalledWith("That would drop your data");
    expect(logMock.info).toHaveBeenCalledWith("Re-run with --force");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("human mode: a returned failure with no hint logs only the message", async () => {
    await runCommand({ json: false }, async () => fail("test_failed", "Tests failed"));
    expect(logMock.error).toHaveBeenCalledWith("Tests failed");
    expect(logMock.info).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("human mode: a returned failure is NOT written to stdout", async () => {
    // The other half of the contract: exactly one result line belongs to JSON
    // mode, and a human terminal must not get a JSON blob beside the sentence.
    await runCommand({ json: false }, async () => fail("nope", "No"));
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test("json mode: a returned failure is the result line, and nothing is logged", async () => {
    await runCommand({ json: true }, async () => fail("no_input", "No value provided", "Pipe it"));
    const written = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(JSON.parse(written.trim())).toEqual({
      ok: false,
      code: "no_input",
      error: "No value provided",
      hint: "Pipe it",
    });
    // `log` is silenced in JSON mode anyway; asserting it keeps the emitter
    // from growing a second, unsilenced write path.
    expect(logMock.error).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("json mode: a failure becomes a machine-readable line and exit 1", async () => {
    await runCommand({ json: true }, async () => {
      throw new CliError("no_input", "Nothing here", "Pipe something in");
    });
    const written = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(JSON.parse(written.trim())).toEqual({
      ok: false,
      code: "no_input",
      error: "Nothing here",
      hint: "Pipe something in",
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("sharedArgs", () => {
  test("declares the flags every platform command shares", () => {
    expect(Object.keys(sharedArgs).sort()).toEqual(["json", "server", "yes"]);
  });
});

describe("defineExec", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, "write").mockImplementation((_chunk, cb?: unknown) => {
      if (typeof cb === "function") (cb as () => void)();
      return true;
    });
  });

  /**
   * Run a defined command through citty itself, so the argv → `args` parse is
   * the real one rather than a hand-built context.
   */
  const invoke = async <T extends ArgsDef>(
    cmd: CommandDef<T>,
    rawArgs: string[] = [],
  ): Promise<void> => {
    await runCittyCommand(cmd, { rawArgs });
  };

  test('cwd: "agent" refuses a directory with no agent.ts, through the one emitter', async () => {
    // The policy is the whole reason this wrapper exists: `aai test` shipped
    // without it and reported a green skipped suite in an empty directory.
    await withTempDir(async (dir) => {
      vi.stubEnv("INIT_CWD", dir);
      const body = vi.fn();
      const cmd = defineExec({
        meta: { name: "needs-agent" },
        args: { json: sharedArgs.json },
        cwd: "agent",
        run: body,
      });

      await invoke(cmd, ["--json=false"]);

      expect(body).not.toHaveBeenCalled();
      // The refusal converges on the same emitter as everything else rather
      // than escaping the command as an unhandled rejection.
      expect(logMock.error).toHaveBeenCalledWith(expect.stringContaining("No agent.ts found"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  test('cwd: "agent" hands the body the directory once agent.ts is there', async () => {
    await withTempDir(async (dir) => {
      vi.stubEnv("INIT_CWD", dir);
      await fs.writeFile(path.join(dir, "agent.ts"), "export {};");
      const body = vi.fn().mockResolvedValue(ok({}));
      const cmd = defineExec({
        meta: { name: "needs-agent" },
        args: { json: sharedArgs.json },
        cwd: "agent",
        run: body,
      });

      await invoke(cmd, ["--json=false"]);

      expect(body).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir, mode: "human" }));
    });
  });

  test('cwd: "any" runs in a directory with no agent.ts', async () => {
    await withTempDir(async (dir) => {
      vi.stubEnv("INIT_CWD", dir);
      const body = vi.fn().mockResolvedValue(ok({}));
      const cmd = defineExec({
        meta: { name: "anywhere" },
        args: { json: sharedArgs.json },
        cwd: "any",
        run: body,
      });

      await invoke(cmd, ["--json=false"]);

      expect(body).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir }));
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  test('cwd: "none" hands the body no directory at all', async () => {
    const body = vi.fn().mockResolvedValue(ok({}));
    const cmd = defineExec({
      meta: { name: "rootless" },
      args: { json: sharedArgs.json },
      cwd: "none",
      run: body,
    });

    await invoke(cmd, ["--json=false"]);

    expect(body).toHaveBeenCalledWith(expect.objectContaining({ cwd: undefined }));
  });

  test("the body's mode follows --json, and a returned failure still exits 1", async () => {
    const cmd = defineExec({
      meta: { name: "jsonful" },
      args: { json: sharedArgs.json },
      cwd: "none",
      run: async ({ mode }) => fail("nope", `mode=${mode}`),
    });

    await invoke(cmd, ["--json"]);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
