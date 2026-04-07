// Copyright 2025 the AAI authors. MIT license.

import * as p from "@clack/prompts";
import { getServerInfo } from "./_agent.ts";
import { apiRequestOrThrow } from "./_api-client.ts";
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

export async function runSecretPut(cwd: string, name: string, server?: string): Promise<void> {
  const result = await p.password({ message: `Enter value for ${name}` });
  if (p.isCancel(result)) process.exit(0);
  if (!result) throw new Error("No value provided");

  const { slug } = await secretRequest(
    cwd,
    "",
    { method: "PUT", body: JSON.stringify({ [name]: result }) },
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
