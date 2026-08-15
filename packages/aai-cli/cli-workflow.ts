// Copyright 2026 the AAI authors. MIT license.
/**
 * The `aai workflow` subcommand group.
 *
 * Its own module because `cli.ts` is near the 500-line cap and this is the
 * natural seam: four verbs over one surface, none of which shares anything with
 * the deploy/secret/storage commands beyond `sharedArgs`. The executors are in
 * `workflow.ts` and are imported lazily, exactly as every other command here
 * does it — the CLI's startup path must not pay for a group nobody invoked.
 */

import { defineCommand } from "citty";
import { defineExec, sharedArgs } from "./_cli-common.ts";
import { CliError } from "./_output.ts";

/**
 * `--token` for an agent whose operator set `AAI_WORKFLOW_API_TOKEN`.
 *
 * Not the caller's API key: the workflow API is the agent's own surface and
 * takes its own bearer, so sending a platform credential there would be both
 * useless and a leak. See `workflow.ts`.
 */
const workflowToken = {
  type: "string",
  description: "Bearer for an agent that sets AAI_WORKFLOW_API_TOKEN",
} as const;

/** The positional every run-scoped verb takes. */
const runIdArg = { type: "positional", description: "Run id", required: true } as const;

/**
 * Every verb here reads `.aai/project.json` for the origin and the published
 * slug, and none of them touches `agent.ts` — a directory `aai pull`ed but
 * never edited still names a deployed agent whose runs are worth asking about.
 */
const WORKFLOW_CWD = "any";

const workflowList = defineExec({
  meta: { name: "list", description: "List the workflows this agent declares" },
  args: { server: sharedArgs.server, json: sharedArgs.json, token: workflowToken },
  cwd: WORKFLOW_CWD,
  async run({ args, cwd }) {
    const { executeWorkflowList } = await import("./workflow.ts");
    return executeWorkflowList(cwd, { server: args.server, token: args.token });
  },
});

const workflowRuns = defineExec({
  meta: { name: "runs", description: "List recent runs of one workflow, newest first" },
  args: {
    workflow: { type: "positional", description: "Workflow name", required: true },
    limit: { type: "string", description: "How many runs to list" },
    server: sharedArgs.server,
    json: sharedArgs.json,
    token: workflowToken,
  },
  cwd: WORKFLOW_CWD,
  async run({ args, cwd }) {
    const { executeWorkflowRuns } = await import("./workflow.ts");
    // Parsed here rather than in the executor so a non-numeric value fails as a
    // CLI error naming the flag, not as a query the server rejects.
    const limit = args.limit === undefined ? undefined : Number(args.limit);
    if (limit !== undefined && !Number.isFinite(limit)) {
      throw new CliError("bad_limit", "--limit must be a number");
    }
    return executeWorkflowRuns(cwd, args.workflow, {
      server: args.server,
      token: args.token,
      limit,
    });
  },
});

const workflowShow = defineExec({
  meta: { name: "show", description: "Show one run, including its output" },
  args: { runId: runIdArg, server: sharedArgs.server, json: sharedArgs.json, token: workflowToken },
  cwd: WORKFLOW_CWD,
  async run({ args, cwd }) {
    const { executeWorkflowShow } = await import("./workflow.ts");
    return executeWorkflowShow(cwd, args.runId, {
      server: args.server,
      token: args.token,
    });
  },
});

const workflowCancel = defineExec({
  meta: { name: "cancel", description: "Stop a running workflow run" },
  args: { runId: runIdArg, server: sharedArgs.server, json: sharedArgs.json, token: workflowToken },
  cwd: WORKFLOW_CWD,
  async run({ args, cwd }) {
    const { executeWorkflowCancel } = await import("./workflow.ts");
    return executeWorkflowCancel(cwd, args.runId, {
      server: args.server,
      token: args.token,
    });
  },
});

export const workflow = defineCommand({
  meta: { name: "workflow", description: "Inspect and steer durable workflow runs" },
  subCommands: {
    list: workflowList,
    runs: workflowRuns,
    show: workflowShow,
    cancel: workflowCancel,
  },
});
