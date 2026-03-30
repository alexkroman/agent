// Copyright 2025 the AAI authors. MIT license.

import { getServerInfo } from "./_discover.ts";
import { askPassword } from "./_prompts.ts";
import { log } from "./_ui.ts";

async function apiFetch(
  cwd: string,
  pathSuffix: string,
  init?: RequestInit,
): Promise<{ resp: Response; slug: string }> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd);
  const resp = await fetch(`${serverUrl}/${slug}/secret${pathSuffix}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...init?.headers },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Secret operation failed: ${text}`);
  }
  return { resp, slug };
}

export async function runSecretPut(cwd: string, name: string): Promise<void> {
  const value = await askPassword(`Enter value for ${name}`);
  if (!value) throw new Error("No value provided");

  const { slug } = await apiFetch(cwd, "", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [name]: value }),
  });
  log.success(`Set ${name} for ${slug}`);
}

export async function runSecretDelete(cwd: string, name: string): Promise<void> {
  const { slug } = await apiFetch(cwd, `/${name}`, { method: "DELETE" });
  log.success(`Deleted ${name} from ${slug}`);
}

export async function runSecretList(cwd: string): Promise<void> {
  const { resp } = await apiFetch(cwd, "");
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
