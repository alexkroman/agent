// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import { ensureApiKeyInEnv, fileExists, resolveCwd } from "./_discover.ts";

/** Shared arg definitions for citty commands. */
const sharedArgs = {
  port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
  server: { type: "string", alias: "s", description: "Platform server URL" },
  yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
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
  if (!(await fileExists(path.join(cwd, "agent.ts")))) {
    const { runInitCommand } = await import("./init.ts");
    return runInitCommand({ yes }, { quiet: true });
  }
  return cwd;
}

/** Shared command setup: resolve cwd, optionally scaffold agent and check API key. */
async function setup(
  args?: { yes?: boolean | undefined },
  opts?: { agent?: boolean; apiKey?: boolean },
): Promise<string> {
  let cwd = resolveCwd();
  if (opts?.agent) {
    cwd = await ensureAgent(cwd, args?.yes);
  }
  if (opts?.apiKey) await ensureApiKeyInEnv();
  return cwd;
}

const init = defineCommand({
  meta: { name: "init", description: "Scaffold a new agent project" },
  args: {
    dir: { type: "positional", description: "Project directory", required: false },
    template: { type: "string", alias: "t", description: "Template to use" },
    force: { type: "boolean", alias: "f", description: "Overwrite existing files" },
    yes: sharedArgs.yes,
    skipApi: { type: "boolean", description: "Skip API key check" },
    skipDeploy: { type: "boolean", description: "Skip deploy after scaffolding" },
  },
  async run({ args }) {
    const { runInitCommand } = await import("./init.ts");
    await runInitCommand({
      dir: args.dir,
      template: args.template,
      force: args.force,
      yes: args.yes,
      skipApi: args.skipApi,
      skipDeploy: args.skipDeploy,
    });
  },
});

const dev = defineCommand({
  meta: { name: "dev", description: "Start a local development server" },
  args: {
    port: sharedArgs.port,
    yes: sharedArgs.yes,
  },
  async run({ args }) {
    const cwd = await setup(args, { agent: true, apiKey: true });
    const { runDevCommand } = await import("./dev.ts");
    await runDevCommand({ cwd, port: args.port });
  },
});

const test = defineCommand({
  meta: { name: "test", description: "Run agent tests" },
  async run() {
    const cwd = await setup();
    const { runTestCommand } = await import("./test.ts");
    await runTestCommand(cwd);
  },
});

const build = defineCommand({
  meta: { name: "build", description: "Bundle agent without deploying" },
  args: {
    yes: sharedArgs.yes,
    skipTests: { type: "boolean", description: "Skip running tests before build" },
  },
  async run({ args }) {
    const cwd = await setup(args, { agent: true });
    if (!args.skipTests) {
      const { runVitest } = await import("./test.ts");
      runVitest(cwd);
    }
    const { runBuildCommand } = await import("./_bundler.ts");
    await runBuildCommand(cwd);
  },
});

const deploy = defineCommand({
  meta: { name: "deploy", description: "Bundle and deploy to production" },
  args: {
    server: sharedArgs.server,
    dryRun: { type: "boolean", description: "Validate and bundle without deploying" },
    yes: sharedArgs.yes,
  },
  async run({ args }) {
    const cwd = await setup(args, { agent: true });
    const { runDeployCommand } = await import("./deploy.ts");
    await runDeployCommand({
      cwd,
      ...(args.server ? { server: args.server } : {}),
      ...(args.dryRun ? { dryRun: args.dryRun } : {}),
    });
  },
});

const del = defineCommand({
  meta: { name: "delete", description: "Remove a deployed agent" },
  args: {
    server: sharedArgs.server,
  },
  async run({ args }) {
    const cwd = await setup();
    const { runDeleteCommand } = await import("./delete.ts");
    await runDeleteCommand({
      cwd,
      ...(args.server ? { server: args.server } : {}),
    });
  },
});

const secretPut = defineCommand({
  meta: { name: "put", description: "Create or update a secret" },
  args: {
    name: { type: "positional", description: "Secret name", required: true },
  },
  async run({ args }) {
    const cwd = await setup(undefined, { apiKey: true });
    const { runSecretPut } = await import("./secret.ts");
    await runSecretPut(cwd, args.name);
  },
});

const secretDelete = defineCommand({
  meta: { name: "delete", description: "Delete a secret" },
  args: {
    name: { type: "positional", description: "Secret name", required: true },
  },
  async run({ args }) {
    const cwd = await setup(undefined, { apiKey: true });
    const { runSecretDelete } = await import("./secret.ts");
    await runSecretDelete(cwd, args.name);
  },
});

const secretList = defineCommand({
  meta: { name: "list", description: "List all secrets" },
  async run() {
    const cwd = await setup(undefined, { apiKey: true });
    const { runSecretList } = await import("./secret.ts");
    await runSecretList(cwd);
  },
});

const secret = defineCommand({
  meta: { name: "secret", description: "Manage agent secrets" },
  subCommands: { put: secretPut, delete: secretDelete, list: secretList },
});

const generate = defineCommand({
  meta: { name: "generate", description: "Generate or update agent code with AI" },
  args: {
    prompt: { type: "positional", description: "Describe the agent to generate", required: true },
  },
  async run({ args }) {
    const cwd = await setup(undefined, { apiKey: true });
    const { runGenerateCommand } = await import("./generate.ts");
    await runGenerateCommand({ cwd, prompt: args.prompt });
  },
});

const run = defineCommand({
  meta: { name: "run", description: "Build and deploy an agent from a prompt" },
  args: {
    prompt: { type: "positional", description: "Describe the agent to build", required: true },
    server: sharedArgs.server,
  },
  async run({ args }) {
    const cwd = await setup({ yes: true }, { agent: true, apiKey: true });
    const { runGenerateCommand } = await import("./generate.ts");
    await runGenerateCommand({ cwd, prompt: args.prompt });
    const { runDeployCommand } = await import("./deploy.ts");
    await runDeployCommand({ cwd, ...(args.server ? { server: args.server } : {}) });
  },
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
    generate,
    run,
  },
});

if (process.env.VITEST !== "true") {
  const sub = process.argv[2];
  const knownCommands = new Set(Object.keys(mainCommand.subCommands ?? {}));
  const helpFlags = new Set(["--help", "--version", "-h", "-V"]);

  if (!sub || (sub.startsWith("-") && !helpFlags.has(sub))) {
    // No argument or unknown flag → default to init
    process.argv.splice(2, 0, "init");
  } else if (!(sub.startsWith("-") || knownCommands.has(sub))) {
    // Bare prompt: aai "build me a flower shop agent" → run
    // Collect all non-flag args into a single prompt string
    const promptParts: string[] = [];
    const flagArgs: string[] = [];
    for (let i = 2; i < process.argv.length; i++) {
      if (process.argv[i]?.startsWith("-")) {
        flagArgs.push(process.argv[i] as string);
        if (i + 1 < process.argv.length && !process.argv[i + 1]?.startsWith("-")) {
          flagArgs.push(process.argv[++i] as string);
        }
      } else {
        promptParts.push(process.argv[i] as string);
      }
    }
    process.argv = [
      process.argv[0] as string,
      process.argv[1] as string,
      "run",
      promptParts.join(" "),
      ...flagArgs,
    ];
  }
  void runMain(mainCommand);
}
