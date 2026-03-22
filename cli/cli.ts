// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { Command } from "commander";
import { errorMessage } from "../sdk/_utils.ts";
import { fileExists, getApiKey, resolveCwd } from "./_discover.ts";
import { interactive, primary } from "./_ink.tsx";

const cliDir = path.dirname(fileURLToPath(import.meta.url));
// Read version from root package.json (single-package repo)
const pkgJsonPath = path.join(cliDir, "..", "package.json");
const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
const VERSION: string = pkgJson.version;

const banner = [
  "",
  `  ${primary(chalk.bold(" ▄▀█ ▄▀█ █"))}   ${chalk.dim("Voice agent development kit")}`,
  `  ${primary(chalk.bold(" █▀█ █▀█ █"))}   ${primary(`v${VERSION}`)}`,
  "",
].join("\n");

const gettingStarted = [
  "",
  `  ${chalk.bold(interactive("Getting started"))}`,
  "",
  `    ${chalk.dim("$")} ${primary("aai init")} ${interactive("my-agent")}`,
  `    ${chalk.dim("$")} ${primary("cd")} ${interactive("my-agent")}`,
  `    ${chalk.dim("$")} ${primary("aai dev")}`,
  "",
].join("\n");

/** Check for agent.ts and scaffold if missing. */
async function ensureAgent(cwd: string, yes?: boolean): Promise<void> {
  if (!(await fileExists(path.join(cwd, "agent.ts")))) {
    const { runInitCommand } = await import("./init.tsx");
    await runInitCommand({ yes }, { quiet: true });
  }
}

/** Hook: inject resolved cwd into command opts. */
function withCwd(cmd: Command): Command {
  return cmd.hook("preAction", (thisCmd) => {
    thisCmd.setOptionValue("cwd", resolveCwd());
  });
}

/** Hook: ensure agent.ts exists (runs init if missing). */
function withAgentGuard(cmd: Command): Command {
  return cmd.hook("preAction", async (thisCmd) => {
    await ensureAgent(thisCmd.getOptionValue("cwd"), thisCmd.opts().yes);
  });
}

/** Hook: pre-resolve API key (may prompt). */
function withApiKey(cmd: Command): Command {
  return cmd.hook("preAction", async () => {
    await getApiKey();
  });
}

function createProgram(): Command {
  const program = new Command();

  program
    .name("aai")
    .version(VERSION, "-V, --version")
    .addHelpText("before", banner)
    .addHelpText("after", gettingStarted);

  program
    .command("init")
    .description("Scaffold a new agent project")
    .argument("[dir]", "Project directory")
    .option("-t, --template <template>", "Template to use")
    .option("-f, --force", "Overwrite existing agent.ts")
    .option("-y, --yes", "Accept defaults (no prompts)")
    .action(
      async (
        dir: string | undefined,
        opts: { template?: string; force?: boolean; yes?: boolean },
      ) => {
        const { runInitCommand } = await import("./init.tsx");
        await runInitCommand({ dir, ...opts });
      },
    );

  withApiKey(
    withAgentGuard(
      withCwd(
        program
          .command("dev")
          .description("Start a local development server")
          .option("-p, --port <number>", "Port to listen on", "3000")
          .option("-y, --yes", "Accept defaults (no prompts)")
          .action(async (opts: { cwd: string; port: string }) => {
            const { runDevCommand } = await import("./dev.tsx");
            await runDevCommand(opts);
          }),
      ),
    ),
  );

  withAgentGuard(
    withCwd(
      program
        .command("build")
        .description("Bundle and validate (no server or deploy)")
        .option("-y, --yes", "Accept defaults (no prompts)")
        .action(async (opts: { cwd: string }) => {
          const { runBuildCommand } = await import("./_build.tsx");
          await runBuildCommand(opts.cwd);
        }),
    ),
  );

  withAgentGuard(
    withCwd(
      program
        .command("deploy")
        .description("Bundle and deploy to production")
        .option("-s, --server <url>", "Server URL")
        .option("--dry-run", "Validate and bundle without deploying")
        .option("-y, --yes", "Accept defaults (no prompts)")
        .action(async (opts: { cwd: string; server?: string; dryRun?: boolean }) => {
          const { runDeployCommand } = await import("./deploy.tsx");
          await runDeployCommand(opts);
        }),
    ),
  );

  withApiKey(
    withCwd(
      program
        .command("start")
        .description("Start production server from build")
        .option("-p, --port <number>", "Port to listen on", "3000")
        .option("-y, --yes", "Accept defaults (no prompts)")
        .action(async (opts: { cwd: string; port: string }) => {
          const { runStartCommand } = await import("./start.tsx");
          await runStartCommand(opts);
        }),
    ),
  );

  const secret = program
    .command("secret")
    .description("Manage secrets")
    .action(() => secret.help());
  withApiKey(withCwd(secret));

  secret
    .command("put")
    .description("Create or update a secret")
    .argument("<name>", "Secret name")
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const cwd = cmd.parent?.getOptionValue("cwd") as string;
      const { runSecretPut } = await import("./secret.tsx");
      await runSecretPut(cwd, name);
    });

  secret
    .command("delete")
    .description("Delete a secret")
    .argument("<name>", "Secret name")
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const cwd = cmd.parent?.getOptionValue("cwd") as string;
      const { runSecretDelete } = await import("./secret.tsx");
      await runSecretDelete(cwd, name);
    });

  secret
    .command("list")
    .description("List secret names")
    .action(async (_opts: unknown, cmd: Command) => {
      const cwd = cmd.parent?.getOptionValue("cwd") as string;
      const { runSecretList } = await import("./secret.tsx");
      await runSecretList(cwd);
    });

  withApiKey(
    withCwd(
      program
        .command("rag")
        .description("Ingest a site's llms-full.txt into the vector store")
        .argument("<url>", "URL to ingest")
        .option("-s, --server <url>", "Server URL")
        .option("--chunk-size <n>", "Max chunk size in tokens", "512")
        .option("-y, --yes", "Accept defaults (no prompts)")
        .action(async (url: string, opts: { cwd: string; server?: string; chunkSize?: string }) => {
          const { runRagCommand } = await import("./rag.tsx");
          await runRagCommand({ url, ...opts });
        }),
    ),
  );

  return program;
}

async function main(args: string[]): Promise<void> {
  // No args → run init (scaffold a new project)
  if (args.length === 0) {
    const { runInitCommand } = await import("./init.tsx");
    await runInitCommand({});
    return;
  }

  const program = createProgram();
  await program.parseAsync(args, { from: "user" });
}

if (process.env.VITEST !== "true") {
  process.on("SIGINT", () => process.exit(0));
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(errorMessage(err));
    process.exit(1);
  });
}

export { createProgram, main };
