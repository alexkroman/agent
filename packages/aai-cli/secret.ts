// Copyright 2025 the AAI authors. MIT license.

import { apiError, apiRequest, HINT_INVALID_API_KEY } from "./_api-client.ts";
import { getServerInfo } from "./_discover.ts";
import { askPassword } from "./_prompts.ts";
import { log } from "./_ui.ts";

async function secretRequest(
  cwd: string,
  pathSuffix: string,
  init?: RequestInit,
  server?: string,
): Promise<{ resp: Response; slug: string }> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, server);
  const resp = await apiRequest(`${serverUrl}/${slug}/secret${pathSuffix}`, {
    ...init,
    apiKey,
    action: "secret",
  });
  if (!resp.ok) {
    const text = await resp.text();
    const hint = resp.status === 401 ? HINT_INVALID_API_KEY : undefined;
    throw apiError("secret", resp.status, text, hint);
  }
  return { resp, slug };
}

export async function runSecretPut(cwd: string, name: string, server?: string): Promise<void> {
  const value = await askPassword(`Enter value for ${name}`);
  if (!value) throw new Error("No value provided");

  const { slug } = await secretRequest(
    cwd,
    "",
    { method: "PUT", body: JSON.stringify({ [name]: value }) },
    server,
  );
  log.success(`Set ${name} for ${slug}`);
}

export async function runSecretDelete(cwd: string, name: string, server?: string): Promise<void> {
  const { slug } = await secretRequest(cwd, `/${name}`, { method: "DELETE" }, server);
  log.success(`Deleted ${name} from ${slug}`);
}

export async function runSecretList(cwd: string, server?: string): Promise<void> {
  const { resp } = await secretRequest(cwd, "", undefined, server);
  const { vars } = (await resp.json()) as { vars: string[] };
  if (vars.length === 0) {
    log.info("No secrets set. Use `aai secret put <name>` to add one.");
  } else {
    log.message(`${vars.length} secret${vars.length === 1 ? "" : "s"}:`);
    for (const name of vars) {
      log.message(`  ${name}`);
    }
  }
}
