/** @jsxImportSource react */
// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import minimist from "minimist";
import { runDeploy } from "./_deploy.ts";
import {
  DEFAULT_SERVER,
  fileExists,
  generateSlug,
  getApiKey,
  isDevMode,
  readProjectConfig,
  writeProjectConfig,
} from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { runWithInk } from "./_ink.tsx";
import { runBuild } from "./build.ts";
import { runNewCommand } from "./new.tsx";

/** CLI definition for the `aai deploy` subcommand, including name, description, and options. */
const deployCommandDef: SubcommandDef = {
  name: "deploy",
  description: "Bundle and deploy to production",
  options: [
    { flags: "-s, --server <url>", description: "Server URL" },
    {
      flags: "--local [url]",
      description: "Use local server",
      hidden: true,
    },
    {
      flags: "--dry-run",
      description: "Validate and bundle without deploying",
    },
    { flags: "-y, --yes", description: "Accept defaults (no prompts)" },
  ],
};

/**
 * Runs the `aai deploy` subcommand. If no `agent.ts` exists in the current
 * directory, scaffolds a new agent first. Then builds the agent bundle,
 * resolves the deploy target (slug), uploads to the server, and
 * prints endpoint URLs.
 *
 * @param args Command-line arguments passed to the `deploy` subcommand.
 * @param version Current CLI version string, used in help output.
 * @throws If the build fails, API key is missing, or deployment fails.
 */
export async function runDeployCommand(args: string[], version: string): Promise<void> {
  const parsed = minimist(args, {
    string: ["server", "local"],
    boolean: ["dry-run", "help", "yes"],
    alias: { s: "server", h: "help", y: "yes" },
  });

  if (parsed.help) {
    console.log(subcommandHelp(deployCommandDef, version));
    return;
  }

  const cwd = process.env.INIT_CWD || process.cwd();

  // If no agent.ts exists, scaffold first (may prompt for template)
  if (!(await fileExists(path.join(cwd, "agent.ts")))) {
    await runNewCommand(parsed.yes ? ["-y"] : [], version);
  }

  const local = parsed.local;
  const serverUrl =
    local !== undefined
      ? typeof local === "string" && local !== ""
        ? local
        : "http://localhost:3100"
      : parsed.server || (isDevMode() ? "http://localhost:3100" : DEFAULT_SERVER);

  const dryRun = parsed["dry-run"] ?? false;

  // Pre-resolve API key (may prompt) before Ink render
  const apiKey = dryRun ? "" : await getApiKey();

  // Read project-local config (.aai/project.json)
  const projectConfig = await readProjectConfig(cwd);

  // Slug: from project config, or generate a new human-readable one
  const slug = projectConfig?.slug ?? generateSlug();

  await runWithInk("Deploying...", async () => {
    const result = await runBuild({ agentDir: cwd });
    const deployed = await runDeploy({
      url: serverUrl,
      bundle: result.bundle,
      env: dryRun ? {} : { ASSEMBLYAI_API_KEY: apiKey },
      slug,
      dryRun,
      apiKey,
    });

    // Save to .aai/project.json (like .vercel/project.json)
    await writeProjectConfig(cwd, {
      slug: deployed.slug,
      serverUrl,
    });
  });
}
