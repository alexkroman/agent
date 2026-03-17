// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import minimist from "minimist";
import { DEFAULT_SERVER, getApiKey, readProjectConfig } from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { detail, step, stepInfo } from "./_output.ts";

/** CLI definition for the `aai env` subcommand. */
const envCommandDef: SubcommandDef = {
  name: "env",
  description: "Manage environment variables",
  options: [
    { flags: "add <name>", description: "Set an environment variable" },
    { flags: "rm <name>", description: "Remove an environment variable" },
    { flags: "ls", description: "List environment variable names" },
    {
      flags: "pull [filename]",
      description: "Pull env vars into .env (default: .env)",
    },
  ],
};

async function requireProjectConfig(cwd: string) {
  const config = await readProjectConfig(cwd);
  if (!config) {
    throw new Error("No .aai/project.json found — deploy first with `aai deploy`");
  }
  return config;
}

/**
 * Runs the `aai env` subcommand.
 *
 * Subcommands:
 *   aai env add <NAME>    — prompt for value, store on server
 *   aai env rm <NAME>     — remove from server
 *   aai env ls            — list env var names
 *   aai env pull [file]   — download env vars to .env file
 */
export async function runEnvCommand(args: string[], version: string): Promise<void> {
  const parsed = minimist(args, {
    boolean: ["help"],
    alias: { h: "help" },
    stopEarly: true,
  });

  if (parsed.help || parsed._.length === 0) {
    console.log(subcommandHelp(envCommandDef, version));
    return;
  }

  const sub = String(parsed._[0]);
  const cwd = process.env.INIT_CWD || process.cwd();

  switch (sub) {
    case "add":
      await envAdd(cwd, String(parsed._[1] ?? ""));
      break;
    case "rm":
    case "remove":
      await envRemove(cwd, String(parsed._[1] ?? ""));
      break;
    case "ls":
    case "list":
      await envList(cwd);
      break;
    case "pull":
      await envPull(cwd, String(parsed._[1] ?? ".env"));
      break;
    default:
      throw new Error(`Unknown env subcommand: ${sub}`);
  }
}

async function getServerInfo(cwd: string) {
  const config = await requireProjectConfig(cwd);
  const apiKey = await getApiKey();
  const serverUrl = config.serverUrl || DEFAULT_SERVER;
  const slug = config.slug;
  return { serverUrl, slug, apiKey };
}

async function envAdd(cwd: string, name: string): Promise<void> {
  if (!name) throw new Error("Usage: aai env add <NAME>");

  const { password } = await import("@inquirer/prompts");
  const value = await password({ message: `Enter value for ${name}` });
  if (!value) throw new Error("No value provided");

  const { serverUrl, slug, apiKey } = await getServerInfo(cwd);

  const resp = await fetch(`${serverUrl}/${slug}/env`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ [name]: value }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to set env var: ${text}`);
  }

  step("Set", `${name} for ${slug}`);
}

async function envRemove(cwd: string, name: string): Promise<void> {
  if (!name) throw new Error("Usage: aai env rm <NAME>");

  const { serverUrl, slug, apiKey } = await getServerInfo(cwd);

  const resp = await fetch(`${serverUrl}/${slug}/env/${name}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to remove env var: ${text}`);
  }

  step("Removed", `${name} from ${slug}`);
}

async function envList(cwd: string): Promise<void> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd);

  const resp = await fetch(`${serverUrl}/${slug}/env`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to list env vars: ${text}`);
  }

  const { vars } = await resp.json();
  if (vars.length === 0) {
    stepInfo("Env", "No environment variables set");
  } else {
    for (const name of vars) {
      detail(name);
    }
  }
}

async function envPull(cwd: string, filename: string): Promise<void> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd);

  const resp = await fetch(`${serverUrl}/${slug}/env`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to pull env vars: ${text}`);
  }

  const { vars } = await resp.json();

  // Write .env with just the names (user fills in values for local dev)
  const lines = (vars as string[]).map((name: string) => `${name}=`);
  const filePath = `${cwd}/${filename}`;
  await fs.writeFile(filePath, `${lines.join("\n")}\n`);

  step("Pulled", `${vars.length} env vars to ${filename}`);
  stepInfo("Note", "Fill in values for local development");
}
