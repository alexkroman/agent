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

function resolveServerUrl(parsed: minimist.ParsedArgs): string {
  return parsed.server || (isDevMode() ? "http://localhost:3100" : DEFAULT_SERVER);
}

async function buildAgent(cwd: string, log: (el: React.ReactNode) => void): Promise<BundleOutput> {
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
  return bundle;
}

async function deployBundle(opts: {
  bundle: BundleOutput;
  serverUrl: string;
  apiKey: string;
  slug: string;
  cwd: string;
  log: (el: React.ReactNode) => void;
}): Promise<string> {
  const { bundle, serverUrl, apiKey, cwd, log } = opts;
  let { slug } = opts;

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

  await writeProjectConfig(cwd, { slug, serverUrl });

  const agentUrl = `${serverUrl}/${slug}`;
  log(<Step action="Ready" msg={agentUrl} />);
  return agentUrl;
}

/**
 * Runs the `aai deploy` subcommand. Builds the agent bundle, uploads to the
 * server, and shows a success message with the live URL.
 */
export async function runDeployCommand(args: string[], version: string): Promise<void> {
  const parsed = minimist(args, {
    string: ["server"],
    boolean: ["dry-run", "help", "yes"],
    alias: { s: "server", h: "help", y: "yes" },
  });

  if (parsed.help) {
    console.log(subcommandHelp(deployCommandDef, version));
    return;
  }

  const cwd = process.env.INIT_CWD || process.cwd();

  if (!(await fileExists(path.join(cwd, "agent.ts")))) {
    await runInitCommand(parsed.yes ? ["-y"] : [], version, { quiet: true });
  }

  const serverUrl = resolveServerUrl(parsed);
  const dryRun = parsed["dry-run"] ?? false;
  const apiKey = dryRun ? "" : await getApiKey();
  const projectConfig = await readProjectConfig(cwd);
  const slug = projectConfig?.slug ?? generateSlug();

  let agentUrl = "";

  await runWithInk(async (log) => {
    const bundle = await buildAgent(cwd, log);

    if (dryRun) {
      log(<StepInfo action="Dry run" msg={`would deploy as ${slug}`} />);
      return;
    }

    agentUrl = await deployBundle({ bundle, serverUrl, apiKey, slug, cwd, log });
  });

  if (agentUrl && !dryRun) {
    const open = await askConfirm("Open in browser?");
    if (open) {
      const { exec } = await import("node:child_process");
      exec(`open "${agentUrl}"`);
    }
  }
}
