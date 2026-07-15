// Copyright 2025 the AAI authors. MIT license.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import {
  CliError,
  type CommandResult,
  fail,
  getOutputMode,
  type OutputMode,
  withOutput,
  writeLine,
} from "./_output.ts";
import { log, silenceOutput } from "./_ui.ts";
import { errorMessage, fileExists, resolveCwd } from "./_utils.ts";

/** Shared arg definitions for citty commands. */
const sharedArgs = {
  port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
  server: { type: "string", alias: "s", description: "Platform server URL" },
  yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
  json: { type: "boolean", description: "Output JSON (auto-detected in non-TTY)" },
} as const;

const cliDir = path.dirname(fileURLToPath(import.meta.url));
function findPkgJson(dir: string): string {
  try {
    return readFileSync(path.join(dir, "package.json"), "utf-8");
  } catch {
    return readFileSync(path.join(dir, "..", "package.json"), "utf-8");
  }
}
const pkgJson = JSON.parse(findPkgJson(cliDir));
const VERSION: string = pkgJson.version;

/** Shared command setup: resolve cwd, optionally require agent.ts. */
async function setup(opts?: { agent?: boolean }): Promise<string> {
  const cwd = resolveCwd();
  if (opts?.agent) {
    const hasAgent = await fileExists(path.join(cwd, "agent.ts"));
    if (!hasAgent) {
      throw new Error("No agent.ts found in the current directory. Run `aai init` first.");
    }
  }
  return cwd;
}

/** Catch command errors and display a clean message instead of a raw stack trace. */
async function handleErrors(mode: OutputMode, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err: unknown) {
    const code = err instanceof CliError ? err.code : "command_failed";
    const hint = err instanceof CliError ? err.hint : undefined;
    if (mode === "json") {
      const result = fail(code, errorMessage(err), hint);
      await writeLine(`${JSON.stringify(result)}\n`);
      process.exit(1);
    }
    log.error(errorMessage(err));
    process.exit(1);
  }
}

/**
 * Run a command body with standard error handling, output mode resolution, and withOutput wrapping.
 *
 * - `setYes`: json mode sets `args.yes = true` (only meaningful for commands with a `yes` arg).
 * - `apiKey`: prompt for / resolve the AssemblyAI API key before the command body runs
 *   (default true — pass false for commands that never talk to the platform).
 */
async function runCommand(
  args: { json?: boolean | undefined; yes?: boolean | undefined },
  fn: (mode: OutputMode) => Promise<CommandResult<unknown>>,
  opts: { setYes?: boolean; apiKey?: boolean } = {},
): Promise<void> {
  const mode = getOutputMode(args);
  if (mode === "json") {
    silenceOutput();
    if (opts.setYes) args.yes = true;
  }
  await handleErrors(mode, () =>
    withOutput(mode, async () => {
      if (opts.apiKey !== false) {
        // Resolve the key up front so the prompt appears before any slow work
        // (bundling, scaffolding). Lazy import keeps zod off the --help path.
        const { ensureApiKey } = await import("./_config.ts");
        await ensureApiKey();
      }
      return fn(mode);
    }),
  );
}

const init = defineCommand({
  meta: { name: "init", description: "Scaffold a new agent project" },
  args: {
    dir: { type: "positional", description: "Project directory", required: false },
    force: { type: "boolean", alias: "f", description: "Overwrite existing files" },
    template: { type: "string", alias: "t", description: "Template to use (e.g. pizza-ordering)" },
    server: sharedArgs.server,
    yes: sharedArgs.yes,
    json: sharedArgs.json,
    skipApi: { type: "boolean", description: "Skip API key check" },
    skipDeploy: { type: "boolean", description: "Skip deploy after scaffolding" },
  },
  async run({ args }) {
    await runCommand(
      args,
      async (mode) => {
        const { executeInit } = await import("./init.ts");
        return executeInit(
          {
            dir: args.dir,
            force: args.force,
            template: args.template,
            yes: args.yes,
            skipDeploy: args.skipDeploy,
            server: args.server,
          },
          mode === "json" ? { silent: true } : undefined,
        );
      },
      { setYes: true, apiKey: !args.skipApi },
    );
  },
});

const dev = defineCommand({
  meta: { name: "dev", description: "Start a local development server" },
  args: {
    port: sharedArgs.port,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup({ agent: true });
      const { executeDev } = await import("./dev.ts");
      return executeDev({ cwd, port: args.port });
    });
  },
});

const test = defineCommand({
  meta: { name: "test", description: "Run agent tests" },
  args: {
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(
      args,
      async () => {
        const cwd = await setup();
        const { executeTest } = await import("./test.ts");
        return executeTest(cwd);
      },
      { apiKey: false },
    );
  },
});

const build = defineCommand({
  meta: { name: "build", description: "Bundle agent without deploying" },
  args: {
    json: sharedArgs.json,
    skipTests: { type: "boolean", description: "Skip running tests before build" },
  },
  async run({ args }) {
    await runCommand(
      args,
      async () => {
        const cwd = await setup({ agent: true });
        if (!args.skipTests) {
          const { runVitest } = await import("./test.ts");
          runVitest(cwd);
        }
        const { executeBuild } = await import("./_bundler.ts");
        return executeBuild(cwd);
      },
      { apiKey: false },
    );
  },
});

const deploy = defineCommand({
  meta: { name: "deploy", description: "Bundle and deploy to production" },
  args: {
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup({ agent: true });
      const { executeDeploy } = await import("./deploy.ts");
      return executeDeploy({ cwd, ...(args.server ? { server: args.server } : {}) });
    });
  },
});

const del = defineCommand({
  meta: { name: "delete", description: "Remove a deployed agent" },
  args: {
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup();
      const { executeDelete } = await import("./delete.ts");
      return executeDelete({ cwd, ...(args.server ? { server: args.server } : {}) });
    });
  },
});

const secretPut = defineCommand({
  meta: { name: "put", description: "Create or update a secret" },
  args: {
    name: { type: "positional", description: "Secret name", required: true },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async (mode) => {
      const cwd = await setup();
      const { executeSecretPut, readStdin } = await import("./secret.ts");
      const value = mode === "json" ? await readStdin() : undefined;
      if (mode === "json" && !value) {
        throw new CliError("no_input", "No value provided", "Pipe secret value to stdin");
      }
      return executeSecretPut(cwd, args.name, value, args.server);
    });
  },
});

const secretDelete = defineCommand({
  meta: { name: "delete", description: "Delete a secret" },
  args: {
    name: { type: "positional", description: "Secret name", required: true },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup();
      const { executeSecretDelete } = await import("./secret.ts");
      return executeSecretDelete(cwd, args.name, args.server);
    });
  },
});

const secretList = defineCommand({
  meta: { name: "list", description: "List all secrets" },
  args: {
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup();
      const { executeSecretList } = await import("./secret.ts");
      return executeSecretList(cwd, args.server);
    });
  },
});

const secret = defineCommand({
  meta: { name: "secret", description: "Manage agent secrets" },
  subCommands: { put: secretPut, delete: secretDelete, list: secretList },
});

export const mainCommand = defineCommand({
  meta: { name: "aai", version: VERSION, description: "Voice agent development kit" },
  subCommands: {
    init,
    dev,
    test,
    build,
    deploy,
    delete: del,
    secret,
  },
});

if (process.env.VITEST !== "true") {
  const sub = process.argv[2];
  const helpFlags = new Set(["--help", "--version", "-h", "-V"]);

  if (!sub || (sub.startsWith("-") && !helpFlags.has(sub))) {
    // No subcommand: deploy if agent.ts exists, otherwise init
    const defaultCmd = existsSync(path.join(resolveCwd(), "agent.ts")) ? "deploy" : "init";
    process.argv.splice(2, 0, defaultCmd);
  }

  // API key acquisition happens inside runCommand (per-command `apiKey` opt),
  // after citty parses args — so --help/--version never prompt for a key.
  void runMain(mainCommand).catch((err: unknown) => {
    log.error(errorMessage(err));
    process.exitCode = 1;
  });
}
