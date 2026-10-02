// Copyright 2026 the AAI authors. MIT license.
// The studio-workspace command definitions (_studio-commands.ts): what each
// one accepts and advertises. Their executors are studio.test.ts.

import { type ArgsDef, type CommandDef, parseArgs, renderUsage } from "citty";
import { describe, expect, test } from "vitest";
import { list, publish, pull, push } from "./_studio-commands.ts";

/** A command's declared flags, resolved the way citty resolves them. */
async function argsOf<T extends ArgsDef>(cmd: CommandDef<T>): Promise<T> {
  const { args } = cmd;
  if (args === undefined) throw new Error("command declares no args");
  return typeof args === "function" ? await args() : await args;
}

describe("studio commands", () => {
  test.each([
    // A thunk per row: the four commands' arg types differ, so a row cannot
    // carry the command itself through one `renderUsage` signature.
    ["list", () => renderUsage(list), "List your studio projects"],
    ["pull", () => renderUsage(pull), "Pull a studio project"],
    ["push", () => renderUsage(push), "Sync this project's source"],
    ["publish", () => renderUsage(publish), "deploy to production"],
  ])("%s advertises its name, purpose and the platform flags", async (name, usageOf, purpose) => {
    const usage = await usageOf();
    expect(usage).toContain(name);
    expect(usage).toContain(purpose);
    expect(usage).toContain("--server");
    expect(usage).toContain("--json");
  });

  test("pull takes the project, an optional target directory, and its own --force", async () => {
    const args = await argsOf(pull);
    expect(parseArgs(["voice-bot", "out", "-f"], args)).toMatchObject({
      project: "voice-bot",
      dir: "out",
      force: true,
    });
    expect(parseArgs(["voice-bot"], args).dir).toBeUndefined();
    // pull's --force overwrites LOCAL files; it is not push's fast-forward override.
    expect(args.force.description).toContain("non-empty directory");
  });

  test("pull refuses to run without a project name", async () => {
    const args = await argsOf(pull);
    expect(() => parseArgs([], args)).toThrow(/project/i);
  });

  test("push and publish describe --force identically, since publish pushes first", async () => {
    const pushArgs = await argsOf(push);
    const publishArgs = await argsOf(publish);
    expect(publishArgs.force).toBe(pushArgs.force);
    expect(parseArgs(["-f"], pushArgs).force).toBe(true);
  });

  test("only publish can skip the type check", async () => {
    const publishArgs = await argsOf(publish);
    expect(parseArgs(["--skip-typecheck"], publishArgs)["skip-typecheck"]).toBe(true);
    expect(Object.keys(await argsOf(push))).not.toContain("skip-typecheck");
  });
});
