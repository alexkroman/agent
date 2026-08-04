// Copyright 2026 the AAI authors. MIT license.
// The studio-workspace citty commands (`aai list/pull/push/publish`) —
// definitions only; behavior lives in studio.ts.

import { defineCommand } from "citty";
import { runCommand, setup, sharedArgs } from "./_cli-common.ts";
import { resolveCwd } from "./_utils.ts";

export const list = defineCommand({
  meta: { name: "list", description: "List your studio projects" },
  args: {
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = resolveCwd();
      const { executeList } = await import("./studio.ts");
      return executeList({ cwd, server: args.server });
    });
  },
});

export const pull = defineCommand({
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
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = resolveCwd();
      const { executePull } = await import("./studio.ts");
      return executePull({
        cwd,
        project: args.project,
        dir: args.dir,
        force: args.force,
        server: args.server,
      });
    });
  },
});

export const push = defineCommand({
  meta: { name: "push", description: "Sync this project's source to its studio workspace" },
  args: {
    force: {
      type: "boolean",
      alias: "f",
      description: "Overwrite studio-side changes instead of failing the fast-forward check",
    },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup({ agent: true });
      const { executePush } = await import("./studio.ts");
      return executePush({ cwd, server: args.server, force: args.force });
    });
  },
});

export const publish = defineCommand({
  meta: {
    name: "publish",
    description: "Push to the studio and deploy to production (the studio's Publish button)",
  },
  args: {
    force: {
      type: "boolean",
      alias: "f",
      description: "Overwrite studio-side changes instead of failing the fast-forward check",
    },
    server: sharedArgs.server,
    json: sharedArgs.json,
    skipTypecheck: { type: "boolean", description: "Skip type checking before publishing" },
  },
  async run({ args }) {
    await runCommand(args, async () => {
      const cwd = await setup({ agent: true });
      const { executePublish } = await import("./studio.ts");
      return executePublish({
        cwd,
        server: args.server,
        force: args.force,
        skipTypecheck: args.skipTypecheck,
      });
    });
  },
});
