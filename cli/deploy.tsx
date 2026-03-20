// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import minimist from "minimist";
import { buildAgentBundle } from "./_build.ts";
import type { BundleOutput } from "./_bundler.ts";
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
import { runWithInk, Step, StepInfo } from "./_ink.tsx";
import { askEnter } from "./_prompts.tsx";
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

function resolveServerUrl(parsed: minimist.ParsedArgs): string {
  return parsed.server || (isDevMode() ? "http://localhost:3100" : DEFAULT_SERVER);
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
    bundle,
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
    const bundle = await buildAgentBundle(cwd, log);

    if (dryRun) {
      log(<StepInfo action="Dry run" msg={`would deploy as ${slug}`} />);
      return;
    }

    agentUrl = await deployBundle({ bundle, serverUrl, apiKey, slug, cwd, log });
  });

  if (agentUrl && !dryRun) {
    await askEnter("Press enter to open in browser");
    const { exec } = await import("node:child_process");
    exec(`open "${agentUrl}"`);
  }
}
