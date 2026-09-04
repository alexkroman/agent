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

/**
 * Refuse `aai secret put NAME value` instead of dropping the value.
 *
 * `value` is not a declared positional, and citty drops an undeclared one
 * silently — so the natural guess set the secret to whatever stdin later
 * yielded (usually nothing) and reported no problem, which is the same class
 * of failure as the unknown flag `assertKnownFlags` exists for.
 *
 * REFUSED rather than accepted, deliberately: a value in argv is in the
 * user's shell history and in `ps` output for every process on the machine,
 * and this is the command whose whole subject is a credential. The extra
 * token is NOT echoed back for the same reason.
 */
function refuseValueInArgv(positionals: string[] | undefined): void {
  if (!positionals || positionals.length <= 1) return;
  throw new CliError(
    "usage",
    "`aai secret put` takes only the secret NAME — the value is read from stdin.",
    'Pipe it in: `printf %s "$VALUE" | aai secret put NAME`. A value passed as ' +
      "an argument would be left in your shell history and visible in `ps`.",
  );
}

const secretPut = defineExec({
  // The stdin contract belongs in `--help` — that is where someone looks when
  // a command appears to hang, and it said only "NAME". It is split across
  // the two slots citty renders: `description` is repeated in the GROUP
  // listing (`aai secret --help`), so it stays one line, and the positional's
  // description carries the copy-pasteable form plus the fact that the value
  // is not an argument at all.
  meta: {
    name: "put",
    description: "Create or update a secret (value read from stdin, or prompted on a terminal)",
  },
  args: {
    name: {
      type: "positional",
      description:
        "Secret name. The VALUE is not an argument — pipe it in " +
        '(`printf %s "$VALUE" | aai secret put NAME`), or be prompted, masked, ' +
        "when stdin is a terminal",
      required: true,
    },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  cwd: "any",
  async run({ args, mode, cwd }) {
    refuseValueInArgv(args._);
    const { executeSecretPut, resolveSecretValue } = await import("./secret.ts");
    // Resolved here, not inside the executor: which SOURCE a value comes from
    // is a property of the invocation (is stdin a terminal?), and reading
    // stdin when it is one is what made this command block forever.
    const value = await resolveSecretValue(args.name, mode);
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
