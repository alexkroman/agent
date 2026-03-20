// Copyright 2025 the AAI authors. MIT license.

import minimist from "minimist";
import { DEFAULT_SERVER, getApiKey, readProjectConfig } from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { Detail, runWithInk, Step, StepInfo } from "./_ink.tsx";
import { askPassword } from "./_prompts.tsx";

/** CLI definition for the `aai secret` subcommand. */
const secretCommandDef: SubcommandDef = {
  name: "secret",
  description: "Manage secrets",
  options: [
    { flags: "put <name>", description: "Create or update a secret" },
    { flags: "delete <name>", description: "Delete a secret" },
    { flags: "list", description: "List secret names" },
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
 * Runs the `aai secret` subcommand.
 *
 * Subcommands:
 *   aai secret put <NAME>     — prompt for value, store on server
 *   aai secret delete <NAME>  — remove from server
 *   aai secret list            — list secret names
 *   aai secret pull [file]    — download secrets to .env file
 */
export async function runSecretCommand(args: string[], version: string): Promise<void> {
  const parsed = minimist(args, {
    boolean: ["help", "yes"],
    alias: { h: "help", y: "yes" },
    stopEarly: true,
  });

  if (parsed.help || parsed._.length === 0) {
    console.log(subcommandHelp(secretCommandDef, version));
    return;
  }

  const sub = String(parsed._[0]);
  const cwd = process.env.INIT_CWD || process.cwd();

  // Pre-resolve API key (may prompt) before any Ink render
  await getApiKey();

  // For put, also pre-resolve the secret value
  let secretValue: string | undefined;
  if (sub === "put") {
    const name = String(parsed._[1] ?? "");
    if (!name) throw new Error("Usage: aai secret put <NAME>");
    secretValue = await askPassword(`Enter value for ${name}`);
    if (!secretValue) throw new Error("No value provided");
  }

  switch (sub) {
    case "put":
      await secretPut(cwd, String(parsed._[1] ?? ""), secretValue ?? "");
      break;
    case "delete":
      await secretDelete(cwd, String(parsed._[1] ?? ""));
      break;
    case "list":
      await secretList(cwd);
      break;
    default:
      throw new Error(`Unknown secret subcommand: ${sub}`);
  }
}

async function getServerInfo(cwd: string) {
  const config = await requireProjectConfig(cwd);
  const apiKey = await getApiKey();
  const serverUrl = config.serverUrl || DEFAULT_SERVER;
  const slug = config.slug;
  return { serverUrl, slug, apiKey };
}

async function secretPut(cwd: string, name: string, value: string): Promise<void> {
  await runWithInk(async (log) => {
    const { serverUrl, slug, apiKey } = await getServerInfo(cwd);

    const resp = await fetch(`${serverUrl}/${slug}/secret`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ [name]: value }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to set secret: ${text}`);
    }

    log(<Step action="Set" msg={`${name} for ${slug}`} />);
  });
}

async function secretDelete(cwd: string, name: string): Promise<void> {
  if (!name) throw new Error("Usage: aai secret delete <NAME>");

  await runWithInk(async (log) => {
    const { serverUrl, slug, apiKey } = await getServerInfo(cwd);

    const resp = await fetch(`${serverUrl}/${slug}/secret/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to delete secret: ${text}`);
    }

    log(<Step action="Deleted" msg={`${name} from ${slug}`} />);
  });
}

async function secretList(cwd: string): Promise<void> {
  await runWithInk(async (log) => {
    const { serverUrl, slug, apiKey } = await getServerInfo(cwd);

    const resp = await fetch(`${serverUrl}/${slug}/secret`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to list secrets: ${text}`);
    }

    const { vars } = await resp.json();
    if (vars.length === 0) {
      log(<StepInfo action="Secrets" msg="none set" />);
    } else {
      for (const name of vars) {
        log(<Detail msg={name} />);
      }
    }
  });
}
