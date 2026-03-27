// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import { ensureApiKeyInEnv, fileExists, resolveCwd } from "./_discover.ts";

/** Shared arg definitions for citty commands. */
const sharedArgs = {
  port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
  server: { type: "string", alias: "s", description: "Server URL" },
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

async function ensureAgent(cwd: string, yes?: boolean): Promise<void> {
  if (!(await fileExists(path.join(cwd, "agent.ts")))) {
    const { runInitCommand } = await import("./init.ts");
    await runInitCommand({ yes }, { quiet: true });
  }
}

const init = defineCommand({
  meta: { name: "init", description: "Scaffold a new agent project" },
  args: {
    dir: { type: "positional", description: "Project directory", required: false },
    template: { type: "string", alias: "t", description: "Template to use" },
    force: { type: "boolean", alias: "f", description: "Overwrite existing agent.ts" },
    yes: sharedArgs.yes,
    skipApi: { type: "boolean", description: "Skip API key check" },
    skipDeploy: { type: "boolean", description: "Skip post-init deploy" },
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
    port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
    check: { type: "boolean", description: "Start server, verify health, then exit" },
    yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
  },
  async run({ args }) {
    const cwd = resolveCwd();
    await ensureAgent(cwd, args.yes);
    await ensureApiKeyInEnv();
    const { runDevCommand } = await import("./dev.ts");
    await runDevCommand({ cwd, port: args.port, ...(args.check ? { check: args.check } : {}) });
  },
});

const test = defineCommand({
  meta: { name: "test", description: "Run agent tests" },
  async run() {
    const cwd = resolveCwd();
    const { runTestCommand } = await import("./test.ts");
    await runTestCommand(cwd);
  },
});

const build = defineCommand({
  meta: { name: "build", description: "Bundle and validate (no server or deploy)" },
  args: {
    yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
    skipTests: { type: "boolean", description: "Skip running tests before build" },
  },
  async run({ args }) {
    const cwd = resolveCwd();
    await ensureAgent(cwd, args.yes);
    if (!args.skipTests) {
      const { runVitest } = await import("./test.ts");
      runVitest(cwd);
    }
    const { runBuildCommand } = await import("./_build.ts");
    await runBuildCommand(cwd);
  },
});

const deploy = defineCommand({
  meta: { name: "deploy", description: "Bundle and deploy to production" },
  args: {
    server: { type: "string", alias: "s", description: "Server URL" },
    dryRun: { type: "boolean", description: "Validate and bundle without deploying" },
    yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
  },
  async run({ args }) {
    const cwd = resolveCwd();
    await ensureAgent(cwd, args.yes);
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
    server: { type: "string", alias: "s", description: "Server URL" },
  },
  async run({ args }) {
    const cwd = resolveCwd();
    const { runDeleteCommand } = await import("./delete.ts");
    await runDeleteCommand({
      cwd,
      ...(args.server ? { server: args.server } : {}),
    });
  },
});

const start = defineCommand({
  meta: { name: "start", description: "Start production server from build" },
  args: {
    port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
    yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
  },
  async run({ args }) {
    const cwd = resolveCwd();
    await ensureApiKeyInEnv();
    const { runStartCommand } = await import("./start.ts");
    await runStartCommand({ cwd, port: args.port });
  },
});

const secretPut = defineCommand({
  meta: { name: "put", description: "Create or update a secret" },
  args: {
    name: { type: "positional", description: "Secret name", required: true },
  },
  async run({ args }) {
    const cwd = resolveCwd();
    await ensureApiKeyInEnv();
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
    const cwd = resolveCwd();
    await ensureApiKeyInEnv();
    const { runSecretDelete } = await import("./secret.ts");
    await runSecretDelete(cwd, args.name);
  },
});

const secretList = defineCommand({
  meta: { name: "list", description: "List secret names" },
  async run() {
    const cwd = resolveCwd();
    await ensureApiKeyInEnv();
    const { runSecretList } = await import("./secret.ts");
    await runSecretList(cwd);
  },
});

const secret = defineCommand({
  meta: { name: "secret", description: "Manage secrets" },
  subCommands: { put: secretPut, delete: secretDelete, list: secretList },
});

const rag = defineCommand({
  meta: { name: "rag", description: "Ingest a site's llms-full.txt into the vector store" },
  args: {
    url: { type: "positional", description: "URL to ingest", required: true },
    server: { type: "string", alias: "s", description: "Server URL" },
    chunkSize: { type: "string", description: "Max chunk size in tokens", default: "512" },
    yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
  },
  async run({ args }) {
    const cwd = resolveCwd();
    await ensureApiKeyInEnv();
    const { runRagCommand } = await import("./rag.ts");
    await runRagCommand({
      url: args.url,
      cwd,
      ...(args.server ? { server: args.server } : {}),
      chunkSize: args.chunkSize,
    });
  },
});

const doctor = defineCommand({
  meta: { name: "doctor", description: "Check environment health and diagnose issues" },
  args: {
    port: {
      type: "string",
      alias: "p",
      description: "Port to check availability",
      default: "3000",
    },
  },
  async run({ args }) {
    const cwd = resolveCwd();
    const { runDoctorCommand } = await import("./doctor.ts");
    await runDoctorCommand({ cwd, port: args.port });
  },
});

const generate = defineCommand({
  meta: { name: "generate", description: "Generate or modify agent code using AI" },
  args: {
    prompt: { type: "positional", description: "What to generate", required: true },
  },
  async run({ args }) {
    const cwd = resolveCwd();
    await ensureApiKeyInEnv();
    const { runGenerateCommand } = await import("./generate.ts");
    await runGenerateCommand({ cwd, prompt: args.prompt });
  },
});

const run = defineCommand({
  meta: { name: "run", description: "Init, generate, and deploy in one step" },
  args: {
    prompt: { type: "positional", description: "What to build", required: true },
    server: { type: "string", alias: "s", description: "Server URL" },
  },
  async run({ args }) {
    await ensureAgent(resolveCwd(), true);
    await ensureApiKeyInEnv();
    // Re-resolve cwd after init (init may change process.cwd to the new project dir)
    const cwd = resolveCwd();
    const { runGenerateCommand } = await import("./generate.ts");
    await runGenerateCommand({ cwd, prompt: args.prompt });
    const { runDeployCommand } = await import("./deploy.ts");
    await runDeployCommand({ cwd, ...(args.server ? { server: args.server } : {}) });
  },
});

const link = defineCommand({
  meta: {
    name: "link",
    description: "Link local workspace packages into the current project (dev only)",
  },
  async run() {
    const { runLinkCommand } = await import("./_link.ts");
    runLinkCommand(resolveCwd());
  },
});

const unlink = defineCommand({
  meta: { name: "unlink", description: "Restore published package versions (reverses aai link)" },
  async run() {
    const { runUnlinkCommand } = await import("./_link.ts");
    runUnlinkCommand(resolveCwd());
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
    start,
    secret,
    rag,
    generate,
    run,
    link,
    unlink,
    doctor,
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
