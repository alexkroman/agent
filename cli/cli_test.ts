import type { Command } from "commander";
import { CommanderError } from "commander";
import { describe, expect, test } from "vitest";
import { createProgram } from "./cli.ts";

/** Recursively apply exitOverride and configureOutput to all commands. */
function applyTestOverrides(
  cmd: Command,
  output: { writeOut: (str: string) => void; writeErr: (str: string) => void },
) {
  cmd.exitOverride();
  cmd.configureOutput(output);
  for (const sub of cmd.commands) {
    applyTestOverrides(sub, output);
  }
}

/** Create a program that captures output and throws instead of exiting. */
function testProgram() {
  let stdout = "";
  let stderr = "";
  const program = createProgram();
  applyTestOverrides(program, {
    writeOut: (str) => {
      stdout += str;
    },
    writeErr: (str) => {
      stderr += str;
    },
  });
  return {
    parse: (args: string[]) => program.parseAsync(args, { from: "user" }),
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("cli", () => {
  test("--version prints version", async () => {
    const t = testProgram();
    await expect(t.parse(["--version"])).rejects.toThrow(CommanderError);
    expect(t.stdout()).toMatch(/\d+\.\d+/);
  });

  test("--help prints help with banner", async () => {
    const t = testProgram();
    await expect(t.parse(["--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("Voice agent development kit");
    expect(output).toContain("init");
    expect(output).toContain("deploy");
    expect(output).toContain("Getting started");
  });

  test("unknown command prints error", async () => {
    const t = testProgram();
    await expect(t.parse(["nonexistent-command"])).rejects.toThrow(CommanderError);
    expect(t.stderr()).toContain("unknown command");
  });

  test("subcommand --help works", async () => {
    const t = testProgram();
    await expect(t.parse(["deploy", "--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("deploy");
    expect(output).toContain("--dry-run");
    expect(output).toContain("--server");
  });

  test("secret --help lists subcommands", async () => {
    const t = testProgram();
    await expect(t.parse(["secret", "--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("put");
    expect(output).toContain("delete");
    expect(output).toContain("list");
  });

  test("init --help shows template and force options", async () => {
    const t = testProgram();
    await expect(t.parse(["init", "--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("--template");
    expect(output).toContain("--force");
    expect(output).toContain("--yes");
  });

  test("dev --help shows port option", async () => {
    const t = testProgram();
    await expect(t.parse(["dev", "--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("--port");
  });

  test("build --help shows description", async () => {
    const t = testProgram();
    await expect(t.parse(["build", "--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("Bundle and validate");
  });

  test("start --help shows port option", async () => {
    const t = testProgram();
    await expect(t.parse(["start", "--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("--port");
  });

  test("rag --help shows chunk-size and server options", async () => {
    const t = testProgram();
    await expect(t.parse(["rag", "--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("--chunk-size");
    expect(output).toContain("--server");
    expect(output).toContain("<url>");
  });

  test("secret put --help shows name argument", async () => {
    const t = testProgram();
    await expect(t.parse(["secret", "put", "--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("<name>");
  });

  test("secret delete --help shows name argument", async () => {
    const t = testProgram();
    await expect(t.parse(["secret", "delete", "--help"])).rejects.toThrow(CommanderError);
    const output = t.stdout();
    expect(output).toContain("<name>");
  });

  test("-V is alias for --version", async () => {
    const t = testProgram();
    await expect(t.parse(["-V"])).rejects.toThrow(CommanderError);
    expect(t.stdout()).toMatch(/\d+\.\d+/);
  });
});

describe("createProgram", () => {
  test("returns a Commander instance with expected commands", () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("init");
    expect(names).toContain("dev");
    expect(names).toContain("build");
    expect(names).toContain("deploy");
    expect(names).toContain("start");
    expect(names).toContain("secret");
    expect(names).toContain("rag");
  });

  test("program name is 'aai'", () => {
    const program = createProgram();
    expect(program.name()).toBe("aai");
  });
});
