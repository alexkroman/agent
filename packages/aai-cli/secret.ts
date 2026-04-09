// Copyright 2025 the AAI authors. MIT license.

import * as p from "@clack/prompts";
import { getServerInfo } from "./_agent.ts";
import { apiRequestOrThrow } from "./_api-client.ts";
import { type CommandResult, fail, ok } from "./_output.ts";
import { log } from "./_ui.ts";

async function secretRequest(
  cwd: string,
  pathSuffix: string,
  init?: RequestInit,
  server?: string,
): Promise<{ resp: Response; slug: string }> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, server);
  const resp = await apiRequestOrThrow(`${serverUrl}/${slug}/secret${pathSuffix}`, {
    ...init,
    apiKey,
    action: "secret",
  });
  return { resp, slug };
}

/** Read secret value from stdin (for non-TTY / piped input). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

type SecretPutData = { name: string };
type SecretDeleteData = { name: string };
type SecretListData = { secrets: string[] };

/**
 * Execute secret put. If `value` is provided, use it directly (non-TTY path).
 * If not provided, prompt interactively (TTY path).
 */
export async function executeSecretPut(
  cwd: string,
  name: string,
  value: string | undefined,
  server: string | undefined,
): Promise<CommandResult<SecretPutData>> {
  let secretValue = value;

  if (!secretValue) {
    // TTY path — interactive prompt
    const result = await p.password({ message: `Enter value for ${name}` });
    if (p.isCancel(result)) process.exit(0);
    if (!result) return fail("no_input", "No value provided", "Pipe secret value to stdin");
    secretValue = result;
  }

  const { slug } = await secretRequest(
    cwd,
    "",
    { method: "PUT", body: JSON.stringify({ [name]: secretValue }) },
    server,
  );
  log.success(`Set ${name} for ${slug}`);
  return ok({ name });
}

export async function executeSecretDelete(
  cwd: string,
  name: string,
  server: string | undefined,
): Promise<CommandResult<SecretDeleteData>> {
  const { slug } = await secretRequest(cwd, `/${name}`, { method: "DELETE" }, server);
  log.success(`Deleted ${name} from ${slug}`);
  return ok({ name });
}

export async function executeSecretList(
  cwd: string,
  server: string | undefined,
): Promise<CommandResult<SecretListData>> {
  const { resp } = await secretRequest(cwd, "", undefined, server);
  const { vars } = (await resp.json()) as { vars: string[] };
  if (vars.length === 0) {
    log.info("No secrets set. Use `aai secret put <name>` to add one.");
  } else {
    log.message(`${vars.length} secret${vars.length === 1 ? "" : "s"}:`);
    for (const v of vars) {
      log.message(`  ${v}`);
    }
  }
  return ok({ secrets: vars });
}

// Legacy exports for backward compat (human mode)
export const runSecretPut = async (cwd: string, name: string, server?: string) => {
  const result = await executeSecretPut(cwd, name, undefined, server);
  if (!result.ok) throw new Error(result.error);
};
export const runSecretDelete = async (cwd: string, name: string, server?: string) => {
  const result = await executeSecretDelete(cwd, name, server);
  if (!result.ok) throw new Error(result.error);
};
export const runSecretList = async (cwd: string, server?: string) => {
  const result = await executeSecretList(cwd, server);
  if (!result.ok) throw new Error(result.error);
};
