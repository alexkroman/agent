// Copyright 2025 the AAI authors. MIT license.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import { runCommand, setup, sharedArgs, unknownFlagsForArgv } from "./_cli-common.ts";
import { CliError, installStdoutGuard } from "./_output.ts";
import { list, publish, pull, push } from "./_studio-commands.ts";
import { log } from "./_ui.ts";
import { AGENT_ENTRY, errorMessage, resolveCwd } from "./_utils.ts";

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

const init = defineCommand({
  meta: { name: "init", description: "Scaffold a new agent project" },
  args: {
    dir: { type: "positional", description: "Project directory", required: false },
    force: { type: "boolean", alias: "f", description: "Overwrite existing files" },
    template: {
      type: "string",
      alias: "t",
      description: "Template to use (run `aai templates` for the list)",
    },
    server: sharedArgs.server,
    yes: sharedArgs.yes,
    json: sharedArgs.json,
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
          // JSON mode is non-interactive — accept defaults as if --yes was passed.
          yes: mode === "json" ? true : args.yes,
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
    port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
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
    skipTypecheck: { type: "boolean", description: "Skip type checking before build" },
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup({ agent: true });
      const { executeBuild } = await import("./build.ts");
      return executeBuild({ cwd, skipTests: args.skipTests, skipTypecheck: args.skipTypecheck });
    });
  },
});

const eject = defineCommand({
  meta: {
    name: "eject",
    description: "Add the self-hosted server.mjs entrypoint to an older project",
  },
  args: {
    force: { type: "boolean", alias: "f", description: "Replace an existing server.mjs" },
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup({ agent: true });
      const { executeEject } = await import("./eject.ts");
      return executeEject({ cwd, force: args.force });
    });
  },
});

// INTERNAL: the raw bundle-upload path. Not a user command — the studio's
// Publish route runs it inside the project's sandbox (aai-guest/
// studio-publish.ts), which is the only production deploy path. Users go
// through `aai publish`.
const deploy = defineCommand({
  meta: { name: "deploy", description: "(internal) used by studio Publish", hidden: true },
  args: {
    server: sharedArgs.server,
    json: sharedArgs.json,
    allowPreviewSlug: {
      type: "boolean",
      description:
        "Permit a `-preview`-suffixed slug (reserved for studio auto-previews; " +
        "studio-internal — a slug you claim this way is subject to the preview reaper)",
    },
    skipTypecheck: { type: "boolean", description: "Skip type checking before deploy" },
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup({ agent: true });
      const { executeDeploy } = await import("./deploy.ts");
      return executeDeploy({
        cwd,
        server: args.server,
        allowPreviewSlug: args.allowPreviewSlug,
        skipTypecheck: args.skipTypecheck,
      });
    });
  },
});

const del = defineCommand({
  meta: {
    name: "delete",
    description: "Delete the studio project and its deployed agents",
  },
  args: {
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup();
      const { executeDelete } = await import("./delete.ts");
      return executeDelete({ cwd, server: args.server });
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
      const { executeSecretPut, NO_INPUT, readStdin } = await import("./secret.ts");
      const value = mode === "json" ? await readStdin() : undefined;
      if (mode === "json" && !value) {
        throw new CliError(...NO_INPUT);
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
  meta: { name: "enable", description: "Enable the agent's app database" },
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
    description: "Disable storage and DROP the database schema with all its data",
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
  meta: { name: "storage", description: "Manage the agent's app database" },
  subCommands: { status: storageStatus, enable: storageEnable, disable: storageDisable },
});

const login = defineCommand({
  meta: { name: "login", description: "Link your signed-in browser account and save your API key" },
  args: {
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const { executeLogin } = await import("./login.ts");
      return executeLogin({ server: args.server });
    });
  },
});

const templates = defineCommand({
  meta: { name: "templates", description: "List available project templates" },
  args: {
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async (mode) => {
      const { listTemplates } = await import("./_templates.ts");
      const names = await listTemplates();
      if (mode === "human") {
        for (const name of names) log.message(name);
        log.info("Scaffold one with `aai init --template <name>`.");
      }
      return { ok: true, data: { templates: names } };
    });
  },
});

export const mainCommand = defineCommand({
  meta: { name: "aai", version: VERSION, description: "Voice agent development kit" },
  subCommands: {
    init,
    dev,
    test,
    build,
    eject,
    list,
    pull,
    push,
    publish,
    deploy,
    delete: del,
    login,
    secret,
    storage,
    templates,
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
    if (!existsSync(path.join(resolveCwd(), AGENT_ENTRY))) {
      process.argv.splice(2, 0, "init");
      return;
    }
    // Publishing is an outward-facing act (it syncs source to the studio
    // and deploys to production) — when there's a human at the terminal,
    // make sure a bare `aai` (often "what does this do?") means it. Non-TTY
    // keeps the implicit behavior: scripts invoking bare `aai` are deliberate.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const p = await import("@clack/prompts");
      const confirmed = await p.confirm({ message: "Publish this agent to production?" });
      if (confirmed !== true) {
        log.info("Cancelled. Run `aai --help` to see all commands.");
        process.exit(0);
      }
    }
    process.argv.splice(2, 0, "publish");
  };

  /**
   * Refuse an unrecognized flag instead of ignoring it.
   *
   * citty drops one silently, so `aai push --serverr=http://x` exited 0 having
   * pushed to the DEFAULT server. `--server` decides where the API key and
   * secret values go, so a typo that quietly retargets it is worth failing on.
   */
  const assertKnownFlags = async (): Promise<void> => {
    const unknown = await unknownFlagsForArgv(mainCommand, process.argv.slice(2));
    if (unknown.length === 0) return;
    log.error(`Unknown ${unknown.length === 1 ? "option" : "options"}: ${unknown.join(", ")}`);
    log.info("Run `aai <command> --help` to see the options it accepts.");
    process.exit(1);
  };

  // API key acquisition happens inside the platform commands, after citty
  // parses args — so --help/--version never prompt for a key.
  void runDefault()
    .then(assertKnownFlags)
    .then(() => runMain(mainCommand))
    .catch((err: unknown) => {
      log.error(errorMessage(err));
      process.exitCode = 1;
    });
}
