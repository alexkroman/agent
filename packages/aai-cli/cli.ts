// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "@alexkroman1/aai-core";
import { defineCommand, runMain } from "citty";
import { CliError, fail, getOutputMode, type OutputMode } from "./_output.ts";
import { silenceOutput } from "./_ui.ts";
import { fileExists, resolveCwd } from "./_utils.ts";

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

async function ensureAgent(cwd: string, yes?: boolean): Promise<string> {
  const hasAgentTs = await fileExists(path.join(cwd, "agent.ts"));
  if (!hasAgentTs) {
    const { runInitCommand } = await import("./init.ts");
    return runInitCommand({ yes }, { quiet: true });
  }
  return cwd;
}

/** Shared command setup: resolve cwd, optionally scaffold agent. */
async function setup(
  args?: { yes?: boolean | undefined },
  opts?: { agent?: boolean },
): Promise<string> {
  let cwd = resolveCwd();
  if (opts?.agent) {
    cwd = await ensureAgent(cwd, args?.yes);
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
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(1);
    }
    const { log } = await import("./_ui.ts");
    log.error(errorMessage(err));
    process.exit(1);
  }
}

/** Resolve output mode, silence output and set yes=true if JSON. */
function resolveMode(args: { json?: boolean | undefined; yes?: boolean | undefined }): OutputMode {
  const mode = getOutputMode(args);
  if (mode === "json") {
    silenceOutput();
    args.yes = true;
  }
  return mode;
}

const init = defineCommand({
  meta: { name: "init", description: "Scaffold a new agent project" },
  args: {
    dir: { type: "positional", description: "Project directory", required: false },
    force: { type: "boolean", alias: "f", description: "Overwrite existing files" },
    server: sharedArgs.server,
    yes: sharedArgs.yes,
    json: sharedArgs.json,
    skipApi: { type: "boolean", description: "Skip API key check" },
    skipDeploy: { type: "boolean", description: "Skip deploy after scaffolding" },
  },
  async run({ args }) {
    const mode = resolveMode(args);
    await handleErrors(mode, async () => {
      const { executeInit } = await import("./init.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(
        mode,
        () =>
          executeInit(
            {
              dir: args.dir,
              force: args.force,
              yes: args.yes,
              skipApi: args.skipApi,
              skipDeploy: args.skipDeploy,
              server: args.server,
            },
            mode === "json" ? { silent: true } : undefined,
          ),
        () => {
          /* human output handled inside executeInit */
        },
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
    const mode = resolveMode(args);
    await handleErrors(mode, async () => {
      const cwd = await setup(args, { agent: true });
      const { executeDev } = await import("./dev.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(
        mode,
        () => executeDev({ cwd, port: args.port }),
        () => {
          /* human output handled inside */
        },
      );
    });
  },
});

const test = defineCommand({
  meta: { name: "test", description: "Run agent tests" },
  args: {
    json: sharedArgs.json,
  },
  async run({ args }) {
    const mode = getOutputMode(args);
    if (mode === "json") silenceOutput();
    await handleErrors(mode, async () => {
      const cwd = await setup();
      const { executeTest } = await import("./test.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(
        mode,
        () => executeTest(cwd),
        () => {
          /* human output handled inside */
        },
      );
    });
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
    const mode = resolveMode(args);
    await handleErrors(mode, async () => {
      const cwd = await setup(args, { agent: true });
      if (!args.skipTests) {
        const { runVitest } = await import("./test.ts");
        runVitest(cwd);
      }
      const { executeBuild } = await import("./_bundler.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(
        mode,
        () => executeBuild(cwd),
        () => {
          /* human output handled inside */
        },
      );
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
    const mode = resolveMode(args);
    await handleErrors(mode, async () => {
      const cwd = await setup(args, { agent: true });
      const { executeDeploy } = await import("./deploy.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(
        mode,
        () => executeDeploy({ cwd, ...(args.server ? { server: args.server } : {}) }),
        () => {
          /* human output handled inside executeDeploy */
        },
      );
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
    const mode = getOutputMode(args);
    if (mode === "json") silenceOutput();
    await handleErrors(mode, async () => {
      const cwd = await setup();
      const { executeDelete } = await import("./delete.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(
        mode,
        () => executeDelete({ cwd, ...(args.server ? { server: args.server } : {}) }),
        () => {
          /* human output handled inside executeDelete */
        },
      );
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
    const mode = getOutputMode(args);
    if (mode === "json") silenceOutput();
    await handleErrors(mode, async () => {
      const cwd = await setup();
      const { executeSecretPut, readStdin } = await import("./secret.ts");
      const { withOutput } = await import("./_output.ts");

      const value = mode === "json" ? await readStdin() : undefined;
      if (mode === "json" && !value) {
        const result = fail("no_input", "No value provided", "Pipe secret value to stdin");
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exit(1);
      }
      await withOutput(
        mode,
        () => executeSecretPut(cwd, args.name, value, args.server),
        () => {
          /* human output handled inside executeSecretPut */
        },
      );
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
    const mode = getOutputMode(args);
    if (mode === "json") silenceOutput();
    await handleErrors(mode, async () => {
      const cwd = await setup();
      const { executeSecretDelete } = await import("./secret.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(
        mode,
        () => executeSecretDelete(cwd, args.name, args.server),
        () => {
          /* human output handled inside */
        },
      );
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
    const mode = getOutputMode(args);
    if (mode === "json") silenceOutput();
    await handleErrors(mode, async () => {
      const cwd = await setup();
      const { executeSecretList } = await import("./secret.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(
        mode,
        () => executeSecretList(cwd, args.server),
        () => {
          /* human output handled inside */
        },
      );
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
    // No argument or unknown flag → default to init
    process.argv.splice(2, 0, "init");
  }

  // Prompt for API key before any command runs (skipped for help/version/test/build)
  const skipApiKey = helpFlags.has(sub ?? "") || sub === "test" || sub === "build";
  const boot = skipApiKey
    ? Promise.resolve()
    : import("./_config.ts").then((m) => m.ensureApiKey());
  void boot.then(() => runMain(mainCommand));
}
