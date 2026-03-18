/** @jsxImportSource react */
// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import minimist from "minimist";
import { interactive, primary } from "./_colors.ts";
import { ensureClaudeMd, ensureDependencies, fileExists, isDevMode } from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { runWithInk } from "./_ink.tsx";
import { listTemplates } from "./_new.ts";
import { askSelect } from "./_prompts.tsx";

/** CLI definition for the `aai new` subcommand, including name, description, arguments, and options. */
const newCommandDef: SubcommandDef = {
  name: "init",
  description: "Scaffold a new agent project",
  args: [{ name: "dir", optional: true }],
  options: [
    {
      flags: "-t, --template <template>",
      description: "Template to use",
    },
    { flags: "-f, --force", description: "Overwrite existing agent.ts" },
    { flags: "-y, --yes", description: "Accept defaults (no prompts)" },
  ],
};

const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  simple: "Minimal starter with search, code, and fetch tools",
  "web-researcher": "Research assistant with web search and page visits",
  "smart-research": "Phase-based research with dynamic tool filtering",
  "memory-agent": "Persistent KV storage across conversations",
  "code-interpreter": "Writes and runs JavaScript for calculations",
  "math-buddy": "Calculations, unit conversions, dice rolls",
  "health-assistant": "Medication lookup, drug interactions, BMI",
  "personal-finance": "Currency, crypto, loans, savings projections",
  "travel-concierge": "Trip planning, weather, flights, hotels",
  "night-owl": "Movie/music/book recs by mood — custom UI",
  "dispatch-center": "911 dispatch with triage — custom UI",
  "infocom-adventure": "Zork-style text adventure — custom UI",
  "embedded-assets": "FAQ bot using embedded JSON knowledge",
  support: "RAG-powered support agent for a documentation site",
  terminal: "STT-only mode for voice-driven commands",
};

/**
 * Interactively prompts for template selection using an arrow-key menu.
 * "simple" is listed first as the default.
 */
async function selectTemplate(available: string[]): Promise<string> {
  const sorted = ["simple", ...available.filter((t) => t !== "simple")];
  const maxLen = Math.max(...sorted.map((t) => t.length));
  const choices = sorted.map((name) => ({
    label: `${name.padEnd(maxLen + 2)}${TEMPLATE_DESCRIPTIONS[name] ?? ""}`,
    value: name,
  }));

  return await askSelect("Which template?", choices);
}

/**
 * Runs the `aai new` subcommand. Scaffolds a new agent project from a template,
 * copies `CLAUDE.md`, and sets up TypeScript tooling for editor support.
 *
 * @param args Command-line arguments passed to the `new` subcommand.
 * @param version Current CLI version string, used in help output.
 * @returns The target directory where the agent was scaffolded.
 */
export async function runNewCommand(
  args: string[],
  version: string,
  opts?: { quiet?: boolean },
): Promise<string> {
  const parsed = minimist(args, {
    string: ["template"],
    boolean: ["force", "help", "yes"],
    alias: { t: "template", f: "force", h: "help", y: "yes" },
  });

  if (parsed.help) {
    console.log(subcommandHelp(newCommandDef, version));
    return "";
  }

  const dir = parsed._[0] as string | undefined;
  const cwd = dir ?? (process.env.INIT_CWD || process.cwd());

  if (!parsed.force && (await fileExists(path.join(cwd, "agent.ts")))) {
    console.log(
      `agent.ts already exists in this directory. Use ${interactive("--force")} to overwrite.`,
    );
    process.exit(1);
  }

  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const templatesDir = path.join(cliDir, "..", "templates");
  const { runNew } = await import("./_new.ts");

  // Interactive prompts when flags aren't provided (skip with -y)
  const available = await listTemplates(templatesDir);
  const template = parsed.template || (parsed.yes ? "simple" : await selectTemplate(available));

  // Run scaffolding with Ink spinner
  await runWithInk("Scaffolding...", async () => {
    await runNew({
      targetDir: cwd,
      template,
      templatesDir,
    });

    // In dev mode (running via node/tsx), rewrite @aai dependencies
    // to point at the local monorepo source so builds use latest code.
    if (isDevMode()) {
      const monorepoRoot = path.join(cliDir, "..");
      const pkgJsonPath = path.join(cwd, "package.json");
      const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, "utf-8"));

      // Point @aai packages at local monorepo directories via file: links
      for (const pkg of ["sdk", "ui"]) {
        const localPkgPath = path.join(monorepoRoot, pkg, "package.json");
        const localPkg = JSON.parse(await fs.readFile(localPkgPath, "utf-8"));
        const pkgName = localPkg.name as string; // e.g. "@aai/sdk"
        pkgJson.dependencies[pkgName] = `file:${path.join(monorepoRoot, pkg)}`;
      }

      await fs.writeFile(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
    }

    await ensureClaudeMd(cwd);
    await ensureDependencies(cwd);
  });

  if (!opts?.quiet) {
    const cdNeeded = dir != null;
    console.log();
    console.log(chalk.bold("Next steps:"));
    if (cdNeeded) {
      console.log(`  ${chalk.dim("$")} ${primary(`cd ${path.relative(process.cwd(), cwd)}`)}`);
    }
    console.log(
      `  ${chalk.dim("$")} ${primary("aai dev")}          ${chalk.dim("Start local dev server")}`,
    );
    console.log(
      `  ${chalk.dim("$")} ${primary("aai deploy")}       ${chalk.dim("Deploy to production")}`,
    );
  }

  return cwd;
}
