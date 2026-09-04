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
import { defineExec, platformArgs } from "./_cli-common.ts";
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

/**
 * `--agent <url>` — target a server the caller is running THEMSELVES.
 *
 * The workflow API is the one agent surface that is fully live under `aai dev`,
 * and until this flag existed there was no way to say so: every verb resolved a
 * platform origin plus a PUBLISHED slug, so an undeployed project was told to
 * `aai publish` while the runs it asked about were answering on localhost. A
 * dev server also has no slug segment at all (`createServer` mounts the API on
 * the origin), so a different `--server` could not express it either.
 *
 * Separate from `--server` rather than a mode of it, because the two carry
 * different credentials: `--server` is paired with the user's platform API key
 * and is trust-checked for that reason, where this reaches a bare agent and
 * sends nothing but `--token`. See `workflow.ts`.
 */
const workflowAgent = {
  type: "string",
  description: "Base URL of a server you are running (e.g. `aai dev` on http://localhost:3000)",
} as const;

/** The positional every run-scoped verb takes. */
const runIdArg = { type: "positional", description: "Run id", required: true } as const;

/**
 * The flags all four verbs take. Declared once so a flag added to the group
 * reaches every verb — four hand-copied triples is how one of them ends up
 * without `--token`.
 */
const workflowArgs = {
  ...platformArgs,
  token: workflowToken,
  agent: workflowAgent,
} as const;

/**
 * Every verb here reads `.aai/project.json` for the origin and the published
 * slug, and none of them touches `agent.ts` — a directory `aai pull`ed but
 * never edited still names a deployed agent whose runs are worth asking about.
 */
const WORKFLOW_CWD = "any";

/**
 * The group flags, forwarded.
 *
 * The declaration side is DRY (`workflowArgs`) and the forwarding side was not:
 * four hand-copied `{ server, token, agent }` triples, in the module whose own
 * doc argues that "four hand-copied triples is how one of them ends up without
 * `--token`". A fifth group flag is one edit here rather than four below.
 */
const workflowOpts = (args: {
  server?: string | undefined;
  token?: string | undefined;
  agent?: string | undefined;
}): { server?: string | undefined; token?: string | undefined; agent?: string | undefined } => ({
  server: args.server,
  token: args.token,
  agent: args.agent,
});

const workflowList = defineExec({
  meta: { name: "list", description: "List the workflows this agent declares" },
  args: workflowArgs,
  cwd: WORKFLOW_CWD,
  async run({ args, cwd }) {
    const { executeWorkflowList } = await import("./workflow.ts");
    return executeWorkflowList(cwd, workflowOpts(args));
  },
});

const workflowRuns = defineExec({
  meta: { name: "runs", description: "List recent runs of one workflow, newest first" },
  args: {
    workflow: { type: "positional", description: "Workflow name", required: true },
    limit: { type: "string", description: "How many runs to list" },
    ...workflowArgs,
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
    return executeWorkflowRuns(cwd, args.workflow, { ...workflowOpts(args), limit });
  },
});

const workflowShow = defineExec({
  meta: { name: "show", description: "Show one run, including its output" },
  args: { runId: runIdArg, ...workflowArgs },
  cwd: WORKFLOW_CWD,
  async run({ args, cwd }) {
    const { executeWorkflowShow } = await import("./workflow.ts");
    return executeWorkflowShow(cwd, args.runId, workflowOpts(args));
  },
});

const workflowCancel = defineExec({
  meta: { name: "cancel", description: "Stop a running workflow run" },
  args: { runId: runIdArg, ...workflowArgs },
  cwd: WORKFLOW_CWD,
  async run({ args, cwd }) {
    const { executeWorkflowCancel } = await import("./workflow.ts");
    return executeWorkflowCancel(cwd, args.runId, workflowOpts(args));
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
