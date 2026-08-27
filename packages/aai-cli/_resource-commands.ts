// Copyright 2026 the AAI authors. MIT license.
// The agent-resource citty commands (`aai secret/logs`) — definitions
// only; behavior lives in secret.ts and logs.ts.
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
