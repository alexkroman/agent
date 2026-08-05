// Copyright 2026 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { CliError, ok } from "./_output.ts";
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

const { findUnknownFlags, runCommand, setup, sharedArgs, unknownFlagsForArgv } = await import(
  "./_cli-common.ts"
);

describe("findUnknownFlags", () => {
  const argsDef = {
    server: { type: "string", alias: "s" },
    force: { type: "boolean", alias: "f" },
    json: { type: "boolean" },
    allowMissingSecrets: { type: "boolean" },
    dir: { type: "positional", required: false },
  } as const;

  test("accepts the kebab-case spelling of a camelCase flag", () => {
    // citty accepts both, and the guest's in-sandbox Publish spawns
    // `aai deploy --allow-missing-secrets --allow-preview-slug`. Matching only
    // the camelCase name broke Publish outright.
    expect(findUnknownFlags(["--allow-missing-secrets"], argsDef)).toEqual([]);
    expect(findUnknownFlags(["--allowMissingSecrets"], argsDef)).toEqual([]);
    expect(findUnknownFlags(["--no-allow-missing-secrets"], argsDef)).toEqual([]);
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

describe("unknownFlagsForArgv", () => {
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
        "--allow-missing-secrets",
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

  afterEach(() => {
    vi.clearAllMocks();
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
