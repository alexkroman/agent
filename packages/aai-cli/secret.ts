// Copyright 2025 the AAI authors. MIT license.

import { text } from "node:stream/consumers";
import * as p from "@clack/prompts";
import { type CommandResult, fail, ok } from "./_output.ts";
import { slugRequest } from "./_slug-api.ts";
import { log, unwrapCancel } from "./_ui.ts";

/**
 * The one `no_input` failure for `secret put`, shared by the JSON-mode stdin
 * path (cli.ts) and the TTY prompt path below so the two can't drift.
 */
export const NO_INPUT = ["no_input", "No value provided", "Pipe secret value to stdin"] as const;

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
    const result = unwrapCancel(await p.password({ message: `Enter value for ${name}` }));
    if (!result) return fail(...NO_INPUT);
    secretValue = result;
  }

  const { slug } = await slugRequest(
    cwd,
    "/secret",
    { method: "PUT", body: { [name]: secretValue }, action: "secret" },
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
  // Encoded so a name containing `/`, `?`, `#`, or `%` can't target a
  // different path (or truncate the request) on the server.
  const { slug } = await slugRequest(
    cwd,
    `/secret/${encodeURIComponent(name)}`,
    { method: "DELETE", action: "secret" },
    server,
  );
  log.success(`Deleted ${name} from ${slug}`);
  return ok({ name });
}

export async function executeSecretList(
  cwd: string,
  server: string | undefined,
): Promise<CommandResult<SecretListData>> {
  const {
    data: { vars },
  } = await slugRequest<{ vars: string[] }>(cwd, "/secret", { action: "secret" }, server);
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
