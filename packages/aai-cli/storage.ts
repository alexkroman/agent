// Copyright 2025 the AAI authors. MIT license.

import { isRecord } from "@alexkroman1/aai/utils";
import * as p from "@clack/prompts";
import { type ApiRequestOptions, checkedResponse } from "./_api-client.ts";
import { type CommandResult, fail, ok } from "./_output.ts";
import { slugRequest } from "./_slug-api.ts";
import { log } from "./_ui.ts";

/**
 * The storage route's answer, CHECKED — every caller here reads `enabled` and
 * a body without it reported "Storage is disabled for <slug>" (and returned
 * `enabled: undefined` to a script) for a server that never said so. See
 * `checkedResponse`.
 */
async function storageRequest(
  cwd: string,
  init?: Pick<ApiRequestOptions, "method">,
  server?: string,
): Promise<{ enabled: boolean; slug: string }> {
  const { data, slug } = await slugRequest(cwd, "/storage", { ...init, action: "storage" }, server);
  const checked = checkedResponse(
    data,
    (value): value is { enabled: boolean } => isRecord(value) && typeof value.enabled === "boolean",
    `the storage route for ${slug}`,
  );
  return { enabled: checked.enabled, slug };
}

type StorageStatusData = { slug: string; enabled: boolean };

export async function executeStorageStatus(
  cwd: string,
  server: string | undefined,
): Promise<CommandResult<StorageStatusData>> {
  const { enabled, slug } = await storageRequest(cwd, undefined, server);
  if (enabled) {
    log.info(`Storage is enabled for ${slug}`);
  } else {
    log.info(`Storage is disabled for ${slug}. Use \`aai storage enable\` to turn it on.`);
  }
  return ok({ slug, enabled });
}

export async function executeStorageEnable(
  cwd: string,
  server: string | undefined,
): Promise<CommandResult<StorageStatusData>> {
  const { enabled, slug } = await storageRequest(cwd, { method: "POST" }, server);
  log.success(`Storage enabled for ${slug}`);
  log.info("Tool code can now use ctx.db.query(sql, params).");
  return ok({ slug, enabled });
}

export type StorageDisableOpts = {
  server?: string | undefined;
  /** Skip the confirmation prompt (required in non-interactive runs). */
  force?: boolean | undefined;
  /** TTY override for testing. Defaults to real stdin+stdout TTY state. */
  isTTY?: boolean | undefined;
};

/**
 * Disable storage — destructive: the server DROPS the app's database schema
 * and all its data. On a TTY this requires interactive confirmation; without
 * a TTY it refuses unless `--force` is passed, so a script can never drop
 * data by accident.
 */
export async function executeStorageDisable(
  cwd: string,
  opts: StorageDisableOpts = {},
): Promise<CommandResult<StorageStatusData>> {
  if (!opts.force) {
    const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!isTTY) {
      return fail(
        "confirmation_required",
        "Disabling storage drops the app's database schema and ALL its data.",
        "Re-run with --force to disable storage without confirmation.",
      );
    }
    const confirmed = await p.confirm({
      message: "Disable storage? This DROPS the app's database schema and all its data.",
    });
    if (p.isCancel(confirmed) || confirmed !== true) {
      log.info("Cancelled. Storage was left unchanged.");
      return fail("cancelled", "Disable cancelled");
    }
  }

  const { enabled, slug } = await storageRequest(cwd, { method: "DELETE" }, opts.server);
  log.success(`Storage disabled for ${slug} — database schema and data dropped`);
  return ok({ slug, enabled });
}
