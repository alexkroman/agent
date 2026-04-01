// Copyright 2025 the AAI authors. MIT license.
import { renderUsage } from "citty";
import { describe, expect, test } from "vitest";
import { mainCommand } from "./cli.ts";

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
  test("main command has expected subcommands", () => {
    const subs = mainCommand.subCommands as Record<string, unknown>;
    expect(subs).toBeDefined();
    for (const cmd of ["init", "dev", "test", "build", "deploy", "delete", "secret"]) {
      expect(subs[cmd]).toBeDefined();
    }
  });

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
});

describe("cli usage snapshots", () => {
  test("aai --help", async () => {
    const usage = await renderUsage(mainCommand);
    expect(normalize(usage)).toMatchSnapshot();
  });

  // eslint-disable-next-line -- cast is safe, we control the command names
  const sub = (name: string) =>
    (mainCommand.subCommands as Record<string, Parameters<typeof renderUsage>[0]>)[
      name
    ] as Parameters<typeof renderUsage>[0];

  test.each(["init", "dev", "test", "build", "deploy", "delete"])("aai %s --help", async (name) => {
    const usage = await renderUsage(sub(name));
    expect(normalize(usage)).toMatchSnapshot();
  });

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
