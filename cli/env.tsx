/** @jsxImportSource react */
// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import minimist from "minimist";
import { DEFAULT_SERVER, getApiKey, readProjectConfig } from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { Detail, runWithInk, Step, StepInfo } from "./_ink.tsx";
import { askPassword } from "./_prompts.tsx";

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

  // Pre-resolve API key (may prompt) before any Ink render
  await getApiKey();

  // For add, also pre-resolve the secret value
  let envValue: string | undefined;
  if (sub === "add") {
    const name = String(parsed._[1] ?? "");
    if (!name) throw new Error("Usage: aai env add <NAME>");
    envValue = await askPassword(`Enter value for ${name}`);
    if (!envValue) throw new Error("No value provided");
  }

  switch (sub) {
    case "add":
      await envAdd(cwd, String(parsed._[1] ?? ""), envValue!);
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

async function envAdd(cwd: string, name: string, value: string): Promise<void> {
  await runWithInk("Setting...", async (log) => {
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

    log(<Step action="Set" msg={`${name} for ${slug}`} />);
  });
}

async function envRemove(cwd: string, name: string): Promise<void> {
  if (!name) throw new Error("Usage: aai env rm <NAME>");

  await runWithInk("Removing...", async (log) => {
    const { serverUrl, slug, apiKey } = await getServerInfo(cwd);

    const resp = await fetch(`${serverUrl}/${slug}/env/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to remove env var: ${text}`);
    }

    log(<Step action="Removed" msg={`${name} from ${slug}`} />);
  });
}

async function envList(cwd: string): Promise<void> {
  await runWithInk("Loading...", async (log) => {
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
      log(<StepInfo action="Env" msg="No environment variables set" />);
    } else {
      for (const name of vars) {
        log(<Detail msg={name} />);
      }
    }
  });
}

async function envPull(cwd: string, filename: string): Promise<void> {
  await runWithInk("Pulling...", async (log) => {
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

    log(<Step action="Pulled" msg={`${vars.length} env vars to ${filename}`} />);
    log(<StepInfo action="Note" msg="Fill in values for local development" />);
  });
}
