/** @jsxImportSource react */
// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import minimist from "minimist";
import { BundleError, type BundleOutput, bundleAgent } from "./_bundler.ts";
import { runDeploy } from "./_deploy.ts";
import {
  DEFAULT_SERVER,
  fileExists,
  generateSlug,
  getApiKey,
  isDevMode,
  loadAgent,
  readProjectConfig,
  writeProjectConfig,
} from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { runWithInk, Step, StepInfo } from "./_ink.tsx";
import { askConfirm } from "./_prompts.tsx";
import { runInitCommand } from "./init.tsx";

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

async function writeBuildOutput(agentDir: string, bundle: BundleOutput): Promise<void> {
  const buildDir = path.join(agentDir, ".aai", "build");
  await fs.mkdir(buildDir, { recursive: true });
  const writes = [fs.writeFile(path.join(buildDir, "worker.js"), bundle.worker)];
  for (const [relPath, content] of Object.entries(bundle.clientFiles)) {
    const fullPath = path.join(buildDir, "client", relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    writes.push(fs.writeFile(fullPath, content));
  }
  await Promise.all(writes);
}

/**
 * Runs the `aai deploy` subcommand. If no `agent.ts` exists in the current
 * directory, scaffolds a new agent first. Then builds the agent bundle,
 * resolves the deploy target (slug), uploads to the server, and
 * shows a success message with the live URL.
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
    await runInitCommand(parsed.yes ? ["-y"] : [], version, { quiet: true });
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
  let slug = projectConfig?.slug ?? generateSlug();

  let agentUrl = "";

  await runWithInk(async (log) => {
    // Build
    log(<Step action="Build" msg="bundling agent" />);
    const agent = await loadAgent(cwd);
    if (!agent) {
      throw new Error("No agent found — run `aai init` first");
    }

    let bundle: BundleOutput;
    try {
      bundle = await bundleAgent(agent);
    } catch (err) {
      if (err instanceof BundleError) {
        throw new Error(`Bundle failed: ${err.message}`);
      }
      throw err;
    }

    await writeBuildOutput(cwd, bundle);

    if (dryRun) {
      log(<StepInfo action="Dry run" msg={`would deploy as ${slug}`} />);
      return;
    }

    // Deploy
    log(<Step action="Deploy" msg={slug} />);
    const deployed = await runDeploy({
      url: serverUrl,
      bundle: {
        worker: bundle.worker,
        clientFiles: bundle.clientFiles,
        workerBytes: bundle.workerBytes,
      },
      env: { ASSEMBLYAI_API_KEY: apiKey },
      slug,
      dryRun: false,
      apiKey,
    });
    slug = deployed.slug;

    // Save to .aai/project.json
    await writeProjectConfig(cwd, {
      slug: deployed.slug,
      serverUrl,
    });

    agentUrl = `${serverUrl}/${slug}`;
    log(<Step action="Ready" msg={agentUrl} />);
  });

  // Prompt to open URL
  if (agentUrl && !dryRun) {
    const open = await askConfirm("Open in browser?");
    if (open) {
      const { exec } = await import("node:child_process");
      exec(`open "${agentUrl}"`);
    }
  }
}
