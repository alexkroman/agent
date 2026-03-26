// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import { fileExists, getApiKey, resolveCwd } from "./_discover.ts";

const cliDir = path.dirname(fileURLToPath(import.meta.url));
function findPkgJson(dir: string): string {
  try {
    return readFileSync(path.join(dir, "package.json"), "utf-8");
  } catch {
    return readFileSync(path.join(dir, "..", "package.json"), "utf-8");
  }
}
const pkgJson: { version: string } = JSON.parse(findPkgJson(cliDir));
const VERSION = pkgJson.version;

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
    yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
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
    await getApiKey();
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

const start = defineCommand({
  meta: { name: "start", description: "Start production server from build" },
  args: {
    port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
    yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
  },
  async run({ args }) {
    const cwd = resolveCwd();
    await getApiKey();
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
    await getApiKey();
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
    await getApiKey();
    const { runSecretDelete } = await import("./secret.ts");
    await runSecretDelete(cwd, args.name);
  },
});

const secretList = defineCommand({
  meta: { name: "list", description: "List secret names" },
  async run() {
    const cwd = resolveCwd();
    await getApiKey();
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
    await getApiKey();
    const { runRagCommand } = await import("./rag.ts");
    await runRagCommand({
      url: args.url,
      cwd,
      ...(args.server ? { server: args.server } : {}),
      chunkSize: args.chunkSize,
    });
  },
});

const link = defineCommand({
  meta: {
    name: "link",
    description: "Link local workspace packages into the current project (dev only)",
  },
  async run() {
    const { runLinkCommand } = await import("./_link.ts");
    await runLinkCommand(resolveCwd());
  },
});

const unlink = defineCommand({
  meta: { name: "unlink", description: "Restore published package versions (reverses aai link)" },
  async run() {
    const { runUnlinkCommand } = await import("./_link.ts");
    await runUnlinkCommand(resolveCwd());
  },
});

export const mainCommand = defineCommand({
  meta: { name: "aai", version: VERSION, description: "Voice agent development kit" },
  subCommands: { init, dev, test, build, deploy, start, secret, rag, link, unlink },
});

if (process.env.VITEST !== "true") {
  // Default to `init` when no subcommand is given (but not for --help/--version)
  const sub = process.argv[2];
  if (
    !sub ||
    (sub.startsWith("-") && sub !== "--help" && sub !== "--version" && sub !== "-h" && sub !== "-V")
  ) {
    process.argv.splice(2, 0, "init");
  }
  runMain(mainCommand).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
