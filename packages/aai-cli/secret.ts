// Copyright 2025 the AAI authors. MIT license.

import { text } from "node:stream/consumers";
import * as p from "@clack/prompts";
import { getServerInfo } from "./_agent.ts";
import { type ApiRequestOptions, apiRequest } from "./_api-client.ts";
import { type CommandResult, fail, ok } from "./_output.ts";
import { log } from "./_ui.ts";

async function secretRequest<T = unknown>(
  cwd: string,
  pathSuffix: string,
  init?: Pick<ApiRequestOptions, "method" | "body">,
  server?: string,
): Promise<{ data: T; slug: string }> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, server);
  const data = await apiRequest<T>(`${serverUrl}/${slug}/secret${pathSuffix}`, {
    ...init,
    apiKey,
    action: "secret",
  });
  return { data, slug };
}

/** Read secret value from stdin (for non-TTY / piped input). */
export async function readStdin(): Promise<string> {
  return (await text(process.stdin)).trim();
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
    { method: "PUT", body: { [name]: secretValue } },
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
  const {
    data: { vars },
  } = await secretRequest<{ vars: string[] }>(cwd, "", undefined, server);
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
