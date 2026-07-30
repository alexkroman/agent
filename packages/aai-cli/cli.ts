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
  installStdoutGuard,
  type OutputMode,
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
/**
 * Read this CLI's own version from its package.json (source layout keeps it
 * next to cli.ts; dist layout one level up). A missing or corrupt file must
 * not brick every command over a cosmetic string — warn and fall back.
 */
function readCliVersion(dir: string): string {
  for (const candidate of [path.join(dir, "package.json"), path.join(dir, "..", "package.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: unknown };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      /* missing or corrupt — try the next candidate */
    }
  }
  process.stderr.write("warning: could not read aai's package.json — reporting version unknown\n");
  return "unknown";
}
const VERSION: string = readCliVersion(cliDir);

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

/**
 * Run a command body with standard output-mode resolution, error handling,
 * and result emission.
 *
 * - `setYes`: json mode sets `args.yes = true` (only meaningful for commands with a `yes` arg).
 * - API key acquisition is owned by `resolveDeployTarget`/`getServerInfo`
 *   inside the commands that talk to the platform — after the server-trust
 *   check, so an untrusted `serverUrl` is refused without prompting for a
 *   key, and commands with no platform traffic never prompt at all.
 *
 * A thrown error and a returned `fail(...)` converge here on one emitter:
 * human mode logs the message, JSON mode writes exactly one result line,
 * and both exit 1.
 */
async function runCommand(
  args: { json?: boolean | undefined; yes?: boolean | undefined },
  fn: (mode: OutputMode) => Promise<CommandResult<unknown>>,
  opts: { setYes?: boolean } = {},
): Promise<void> {
  const mode = getOutputMode(args);
  if (mode === "json") {
    silenceOutput();
    if (opts.setYes) args.yes = true;
  }
  let result: CommandResult<unknown>;
  try {
    result = await fn(mode);
  } catch (err: unknown) {
    const code = err instanceof CliError ? err.code : "command_failed";
    const hint = err instanceof CliError ? err.hint : undefined;
    if (mode === "human") log.error(errorMessage(err));
    result = fail(code, errorMessage(err), hint);
  }
  // Await the flush before exiting: on a pipe (the JSON-mode case) stdout is
  // async, so process.exit() would truncate the JSON line just queued.
  if (mode === "json") await writeLine(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exit(1);
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
    skipApi: {
      type: "boolean",
      description: "Deprecated no-op: the API key is now only requested when deploying",
    },
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
      { setYes: true },
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
    await runCommand(args, async () => {
      const cwd = await setup();
      const { executeTest } = await import("./test.ts");
      return executeTest(cwd);
    });
  },
});

const build = defineCommand({
  meta: { name: "build", description: "Bundle agent without deploying" },
  args: {
    json: sharedArgs.json,
    skipTests: { type: "boolean", description: "Skip running tests before build" },
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup({ agent: true });
      if (!args.skipTests) {
        const { classifyVitestError, runVitest } = await import("./test.ts");
        // Distinguish a real test failure (test_failed) from the runner not
        // spawning (spawn_failed) instead of a generic command_failed.
        const toCliError = (err: unknown): CliError => {
          const { code, message } = classifyVitestError(err);
          return new CliError(code, message, "Re-run with --skipTests to build without tests", {
            cause: err,
          });
        };
        try {
          runVitest(cwd);
        } catch (err: unknown) {
          throw toCliError(err);
        }
      }
      const { executeBuild } = await import("./_bundler.ts");
      return executeBuild(cwd);
    });
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

/** Resolve the working directory for a storage subcommand's optional [dir]. */
function resolveStorageCwd(dir: string | undefined): string {
  const cwd = resolveCwd();
  return dir ? path.resolve(cwd, dir) : cwd;
}

const storageDir = {
  type: "positional",
  description: "Project directory",
  required: false,
} as const;

const storageStatus = defineCommand({
  meta: { name: "status", description: "Show whether storage is enabled" },
  args: {
    dir: storageDir,
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const { executeStorageStatus } = await import("./storage.ts");
      return executeStorageStatus(resolveStorageCwd(args.dir), args.server);
    });
  },
});

const storageEnable = defineCommand({
  meta: { name: "enable", description: "Enable the agent's database (storage)" },
  args: {
    dir: storageDir,
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const { executeStorageEnable } = await import("./storage.ts");
      return executeStorageEnable(resolveStorageCwd(args.dir), args.server);
    });
  },
});

const storageDisable = defineCommand({
  meta: {
    name: "disable",
    description: "Disable storage (DROPS the database schema and all its data)",
  },
  args: {
    dir: storageDir,
    force: { type: "boolean", alias: "f", description: "Skip confirmation prompt" },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const { executeStorageDisable } = await import("./storage.ts");
      return executeStorageDisable(resolveStorageCwd(args.dir), {
        server: args.server,
        force: args.force,
      });
    });
  },
});

const storage = defineCommand({
  meta: { name: "storage", description: "Manage the agent's database (storage)" },
  subCommands: { status: storageStatus, enable: storageEnable, disable: storageDisable },
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
    storage,
  },
});

if (process.env.VITEST !== "true") {
  // JSON mode writes to stdout, which may be a pipe whose consumer exits
  // early (`aai … --json | head -1`) — EPIPE must not crash with a raw stack.
  installStdoutGuard();

  // A default command is injected ONLY on a truly bare `aai` — a leading
  // flag no longer counts as "no subcommand". It used to, which meant a
  // typo like `aai -v` or `aai --hlep` in a deployed project silently
  // became `deploy <flag>` and pushed to production.
  const runDefault = async (): Promise<void> => {
    if (process.argv.length > 2) return;
    if (!existsSync(path.join(resolveCwd(), "agent.ts"))) {
      process.argv.splice(2, 0, "init");
      return;
    }
    // Deploying is an outward-facing act that also executes the project's
    // agent.ts locally — when there's a human at the terminal, make sure a
    // bare `aai` (often "what does this do?") means it. Non-TTY keeps the
    // old behavior: scripts invoking bare `aai` are deliberate.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const p = await import("@clack/prompts");
      const confirmed = await p.confirm({ message: "Deploy this agent to production?" });
      if (confirmed !== true) {
        log.info("Cancelled. Run `aai --help` to see all commands.");
        process.exit(0);
      }
    }
    process.argv.splice(2, 0, "deploy");
  };

  // API key acquisition happens inside the platform commands, after citty
  // parses args — so --help/--version never prompt for a key.
  void runDefault()
    .then(() => runMain(mainCommand))
    .catch((err: unknown) => {
      log.error(errorMessage(err));
      process.exitCode = 1;
    });
}
