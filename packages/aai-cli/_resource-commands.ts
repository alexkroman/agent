// Copyright 2026 the AAI authors. MIT license.
// The agent-resource citty commands (`aai secret/storage/logs`) — definitions
// only; behavior lives in secret.ts, storage.ts and logs.ts.
//
// Split out of `cli.ts` for the file-length cap, along the same seam
// `_studio-commands.ts` already uses: a command GROUP whose behavior is one
// module. What stays in `cli.ts` is the top-level command table.

import path from "node:path";
import { defineCommand } from "citty";
import { defineExec, sharedArgs } from "./_cli-common.ts";
import { CliError } from "./_output.ts";

const secretPut = defineExec({
  meta: { name: "put", description: "Create or update a secret" },
  args: {
    name: { type: "positional", description: "Secret name", required: true },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  cwd: "any",
  async run({ args, mode, cwd }) {
    const { executeSecretPut, NO_INPUT, readStdin } = await import("./secret.ts");
    const value = mode === "json" ? await readStdin() : undefined;
    if (mode === "json" && !value) {
      throw new CliError(...NO_INPUT);
    }
    return executeSecretPut(cwd, args.name, value, args.server);
  },
});

const secretDelete = defineExec({
  meta: { name: "delete", description: "Delete a secret" },
  args: {
    name: { type: "positional", description: "Secret name", required: true },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  cwd: "any",
  async run({ args, cwd }) {
    const { executeSecretDelete } = await import("./secret.ts");
    return executeSecretDelete(cwd, args.name, args.server);
  },
});

const secretList = defineExec({
  meta: { name: "list", description: "List all secrets" },
  args: {
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  cwd: "any",
  async run({ args, cwd }) {
    const { executeSecretList } = await import("./secret.ts");
    return executeSecretList(cwd, args.server);
  },
});

export const secret = defineCommand({
  meta: { name: "secret", description: "Manage agent secrets" },
  subCommands: { put: secretPut, delete: secretDelete, list: secretList },
});

/** An optional `[dir]` positional, resolved against the working directory. */
function resolveDirArg(cwd: string, dir: string | undefined): string {
  return dir ? path.resolve(cwd, dir) : cwd;
}

/**
 * The optional `[dir]` positional the project-scoped subcommands share.
 *
 * Named for what it is rather than for `storage`, which was the only group
 * that had one when it was written — `logs` takes the same positional and
 * read as borrowing another command's arg.
 */
const dirArg = {
  type: "positional",
  description: "Project directory",
  required: false,
} as const;

const storageStatus = defineExec({
  meta: { name: "status", description: "Show whether storage is enabled" },
  args: {
    dir: dirArg,
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  cwd: "any",
  async run({ args, cwd }) {
    const { executeStorageStatus } = await import("./storage.ts");
    return executeStorageStatus(resolveDirArg(cwd, args.dir), args.server);
  },
});

const storageEnable = defineExec({
  meta: { name: "enable", description: "Enable the agent's app database" },
  args: {
    dir: dirArg,
    // The default is the WIDER tier, so an agent that adds workflows without
    // re-running this still works. `--tier storage` is the opt-in, and it is
    // safe to re-run: the server reconciles an existing database's limit
    // without rotating its credential.
    tier: {
      type: "string",
      description:
        "Connection tier: `workflow` (default) or `storage` for an agent with no durable workflows",
    },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  cwd: "any",
  async run({ args, cwd }) {
    const { executeStorageEnable } = await import("./storage.ts");
    return executeStorageEnable(resolveDirArg(cwd, args.dir), args.server, args.tier);
  },
});

const storageDisable = defineExec({
  meta: {
    name: "disable",
    description: "Disable storage and DROP the database schema with all its data",
  },
  args: {
    dir: dirArg,
    force: { type: "boolean", alias: "f", description: "Skip confirmation prompt" },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  cwd: "any",
  async run({ args, cwd }) {
    const { executeStorageDisable } = await import("./storage.ts");
    return executeStorageDisable(resolveDirArg(cwd, args.dir), {
      server: args.server,
      force: args.force,
    });
  },
});

export const logs = defineExec({
  meta: {
    name: "logs",
    description: "Show what the deployed agent has printed",
  },
  args: {
    dir: dirArg,
    follow: { type: "boolean", alias: "f", description: "Keep printing new output" },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  cwd: "any",
  async run({ args, cwd }) {
    const { executeLogs } = await import("./logs.ts");
    return executeLogs(resolveDirArg(cwd, args.dir), {
      server: args.server,
      follow: args.follow,
    });
  },
});

export const storage = defineCommand({
  meta: { name: "storage", description: "Manage the agent's app database" },
  subCommands: { status: storageStatus, enable: storageEnable, disable: storageDisable },
});
