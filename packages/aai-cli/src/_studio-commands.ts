// Copyright 2026 the AAI authors. MIT license.
// The studio-workspace citty commands (`aai list/pull/push/publish`) —
// definitions only; behavior lives in studio.ts.

import { defineExec, platformArgs } from "./_cli-common.ts";

/**
 * The fast-forward override `push` and `publish` share — `publish` pushes
 * first, so the two must always describe the same thing to the user.
 * `pull`'s `--force` is a different act (overwriting local files) and keeps
 * its own wording.
 */
const forceArg = {
  type: "boolean",
  alias: "f",
  description: "Overwrite studio-side changes instead of failing the fast-forward check",
} as const;

export const list = defineExec({
  meta: { name: "list", description: "List your studio projects" },
  args: {
    ...platformArgs,
  },
  // Reads the account's projects; the directory only supplies a `serverUrl`.
  cwd: "any",
  async run({ args, cwd }) {
    const { executeList } = await import("./studio.ts");
    return executeList({ cwd, server: args.server });
  },
});

export const pull = defineExec({
  meta: { name: "pull", description: "Pull a studio project into a local directory" },
  args: {
    project: {
      type: "positional",
      description: "Studio project name (see `aai list`)",
      required: true,
    },
    dir: {
      type: "positional",
      description: "Target directory (default: the project name)",
      required: false,
    },
    force: { type: "boolean", alias: "f", description: "Overwrite files in a non-empty directory" },
    ...platformArgs,
  },
  // It CREATES the project directory — requiring one would be backwards.
  cwd: "any",
  async run({ args, cwd }) {
    const { executePull } = await import("./studio.ts");
    return executePull({
      cwd,
      project: args.project,
      dir: args.dir,
      force: args.force,
      server: args.server,
    });
  },
});

export const push = defineExec({
  meta: { name: "push", description: "Sync this project's source to its studio workspace" },
  args: {
    force: forceArg,
    ...platformArgs,
  },
  cwd: "agent",
  async run({ args, cwd }) {
    const { executePush } = await import("./studio.ts");
    return executePush({ cwd, server: args.server, force: args.force });
  },
});

export const publish = defineExec({
  meta: {
    name: "publish",
    description: "Push to the studio and deploy to production (the studio's Publish button)",
  },
  args: {
    force: forceArg,
    ...platformArgs,
    skipTypecheck: { type: "boolean", description: "Skip type checking before publishing" },
  },
  cwd: "agent",
  async run({ args, cwd }) {
    const { executePublish } = await import("./studio.ts");
    return executePublish({
      cwd,
      server: args.server,
      force: args.force,
      skipTypecheck: args.skipTypecheck,
    });
  },
});
