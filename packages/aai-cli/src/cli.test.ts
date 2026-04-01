// Copyright 2025 the AAI authors. MIT license.
import { renderUsage } from "citty";
import { describe, expect, test } from "vitest";
import { mainCommand } from "./cli.ts";

describe("cli", () => {
  test("main command has expected subcommands", () => {
    const subs = mainCommand.subCommands as Record<string, unknown>;
    expect(subs).toBeDefined();
    for (const cmd of ["init", "dev", "build", "deploy", "delete", "secret"]) {
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

  test("usage includes subcommand names", async () => {
    const usage = await renderUsage(mainCommand);
    expect(usage).toContain("init");
    expect(usage).toContain("deploy");
  });

  test("deploy subcommand has server and dry-run args", () => {
    const subs = mainCommand.subCommands as Record<string, { args?: Record<string, unknown> }>;
    const deployCmd = subs.deploy;
    expect(deployCmd?.args?.server).toBeDefined();
    expect(deployCmd?.args?.dryRun).toBeDefined();
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
