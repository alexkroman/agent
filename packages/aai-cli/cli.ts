// Copyright 2025 the AAI authors. MIT license.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@alexkroman1/aai";
import { defineCommand, runMain } from "citty";
import { CliError, type CommandResult, fail, getOutputMode, type OutputMode } from "./_output.ts";
import { silenceOutput } from "./_ui.ts";
import { fileExists, resolveCwd } from "./_utils.ts";

const sharedArgs = {
  port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
  server: { type: "string", alias: "s", description: "Platform server URL" },
  yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
  json: { type: "boolean", description: "Output JSON (auto-detected in non-TTY)" },
} as const;

// In dev mode the CLI runs from source (cli.ts is alongside package.json); from
// the published dist it lives one level deeper, so fall back to the parent.
const cliDir = path.dirname(fileURLToPath(import.meta.url));
const pkgJsonPath = existsSync(path.join(cliDir, "package.json"))
  ? path.join(cliDir, "package.json")
  : path.join(cliDir, "..", "package.json");
const VERSION: string = JSON.parse(readFileSync(pkgJsonPath, "utf-8")).version;

async function setup(opts?: { agent?: boolean }): Promise<string> {
  const cwd = resolveCwd();
  if (opts?.agent && !(await fileExists(path.join(cwd, "agent.ts")))) {
    throw new Error("No agent.ts found in the current directory. Run `aai init` first.");
  }
  return cwd;
}

async function handleErrors(mode: OutputMode, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const code = err instanceof CliError ? err.code : "command_failed";
    const hint = err instanceof CliError ? err.hint : undefined;
    if (mode === "json") {
      process.stdout.write(`${JSON.stringify(fail(code, errorMessage(err), hint))}\n`);
    } else {
      const { log } = await import("./_ui.ts");
      log.error(errorMessage(err));
    }
    process.exit(1);
  }
}

async function runCommand(
  args: { json?: boolean | undefined; yes?: boolean | undefined },
  fn: (mode: OutputMode) => Promise<CommandResult<unknown>>,
  opts: { setYes?: boolean } = {},
): Promise<void> {
  const mode = getOutputMode(args);
  if (mode === "json") {
    silenceOutput();
    if (opts.setYes !== false) args.yes = true;
  }
  const { withOutput } = await import("./_output.ts");
  await handleErrors(mode, () =>
    withOutput(
      mode,
      () => fn(mode),
      () => {
        /* human output handled inside each execute function */
      },
    ),
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
    await runCommand(args, async (mode) => {
      const { executeInit } = await import("./init.ts");
      return executeInit(
        {
          dir: args.dir,
          force: args.force,
          template: args.template,
          yes: args.yes,
          skipApi: args.skipApi,
          skipDeploy: args.skipDeploy,
          server: args.server,
        },
        mode === "json" ? { silent: true } : undefined,
      );
    });
  },
});

const dev = defineCommand({
  meta: { name: "dev", description: "Start a local development server" },
  args: {
    port: sharedArgs.port,
    server: sharedArgs.server,
    yes: sharedArgs.yes,
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
      { setYes: false },
    );
  },
});

const build = defineCommand({
  meta: { name: "build", description: "Bundle agent without deploying" },
  args: {
    server: sharedArgs.server,
    yes: sharedArgs.yes,
    json: sharedArgs.json,
    skipTests: { type: "boolean", description: "Skip running tests before build" },
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup({ agent: true });
      if (!args.skipTests) {
        const { runVitest } = await import("./test.ts");
        runVitest(cwd);
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
    yes: sharedArgs.yes,
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
    await runCommand(
      args,
      async () => {
        const cwd = await setup();
        const { executeDelete } = await import("./delete.ts");
        return executeDelete({ cwd, ...(args.server ? { server: args.server } : {}) });
      },
      { setYes: false },
    );
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
    await runCommand(
      args,
      async (mode) => {
        const cwd = await setup();
        const { executeSecretPut, readStdin } = await import("./secret.ts");
        const value = mode === "json" ? await readStdin() : undefined;
        if (mode === "json" && !value) {
          const result = fail("no_input", "No value provided", "Pipe secret value to stdin");
          process.stdout.write(`${JSON.stringify(result)}\n`);
          process.exit(1);
        }
        return executeSecretPut(cwd, args.name, value, args.server);
      },
      { setYes: false },
    );
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
    await runCommand(
      args,
      async () => {
        const cwd = await setup();
        const { executeSecretDelete } = await import("./secret.ts");
        return executeSecretDelete(cwd, args.name, args.server);
      },
      { setYes: false },
    );
  },
});

const secretList = defineCommand({
  meta: { name: "list", description: "List all secrets" },
  args: {
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(
      args,
      async () => {
        const cwd = await setup();
        const { executeSecretList } = await import("./secret.ts");
        return executeSecretList(cwd, args.server);
      },
      { setYes: false },
    );
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

  // Prompt for API key before any command runs (skipped for help/version/test/build)
  const cmd = process.argv[2];
  const skipApiKey = helpFlags.has(cmd ?? "") || cmd === "test" || cmd === "build";
  const boot = skipApiKey
    ? Promise.resolve()
    : import("./_config.ts").then((m) => m.ensureApiKey());
  void boot.then(() => runMain(mainCommand));
}
