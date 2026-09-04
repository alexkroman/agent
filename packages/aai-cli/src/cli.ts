// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { omitUndefined, plural } from "@alexkroman1/aai/utils";
import { defineCommand, runMain, showUsage } from "citty";
import {
  commandPath,
  defineExec,
  findUnknownFlags,
  platformArgs,
  resolveArgv,
  sharedArgs,
} from "./_cli-common.ts";
import { fail, getOutputMode, installStdoutGuard, writeLine } from "./_output.ts";
import { logs, secret } from "./_resource-commands.ts";
import { list, publish, pull, push } from "./_studio-commands.ts";
import { log, parsePort } from "./_ui.ts";
import { AGENT_ENTRY, errorMessage, readPackageJson, resolveCwd } from "./_utils.ts";
import { workflow } from "./cli-workflow.ts";

const cliDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * Read this CLI's own version from its package.json (one level up in both the
 * source `src/` layout and the dist layout). A missing or corrupt file must
 * not brick every command over a cosmetic string — warn and fall back.
 */
function readCliVersion(dir: string): string {
  for (const candidate of [path.join(dir, "package.json"), path.join(dir, "..", "package.json")]) {
    try {
      const { version } = readPackageJson(candidate);
      if (typeof version === "string") return version;
    } catch {
      /* missing or corrupt — try the next candidate */
    }
  }
  process.stderr.write("warning: could not read aai's package.json — reporting version unknown\n");
  return "unknown";
}

/**
 * The version, read on FIRST ACCESS rather than at module load.
 *
 * Two synchronous reads and a parse used to run for every invocation of every
 * subcommand, on the startup path this package deliberately budgets (the same
 * one that keeps zod out of `_utils.ts` and `_ui.ts`, and that `bin.mjs` exists
 * to put `module.enableCompileCache()` in front of). Only `--version` and the
 * usage renderer read `meta.version`, and citty reads it as a property — so a
 * getter is transparent to both while charging the file read to the two
 * commands that display it. Memoized because usage rendering reads it twice.
 */
let _version: string | undefined;
const mainMeta = {
  name: "aai",
  description: "Voice agent development kit",
  get version(): string {
    _version ??= readCliVersion(cliDir);
    return _version;
  },
};

const init = defineExec({
  meta: { name: "init", description: "Scaffold a new agent project" },
  args: {
    dir: { type: "positional", description: "Project directory", required: false },
    force: { type: "boolean", alias: "f", description: "Overwrite existing files" },
    template: {
      type: "string",
      alias: "t",
      description: "Template to use (prompted when omitted)",
    },
    // No `--server` and no `--skip-deploy`: `init` scaffolds and stops, so it
    // never talks to a platform. Publishing is `aai publish`, in the project.
    yes: sharedArgs.yes,
    json: sharedArgs.json,
  },
  // It creates the directory it works in, and resolves the target itself.
  cwd: "none",
  async run({ args, mode }) {
    const { executeInit } = await import("./init.ts");
    return executeInit(
      {
        dir: args.dir,
        force: args.force,
        template: args.template,
        // JSON mode is non-interactive — accept defaults as if --yes was passed.
        yes: mode === "json" ? true : args.yes,
      },
      mode === "json" ? { silent: true } : undefined,
    );
  },
});

const dev = defineExec({
  meta: { name: "dev", description: "Start a local development server" },
  args: {
    port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
    // No `default`, deliberately: the absence is what leaves `AAI_DEV_WATCH` in
    // charge, and a `default: false` here would make the flag the only way to
    // enable watching and break every supervisor setting the variable.
    watch: {
      type: "boolean",
      description: "Restart on file changes (also AAI_DEV_WATCH=1)",
    },
    json: sharedArgs.json,
  },
  cwd: "agent",
  async run({ args, cwd }) {
    const { executeDev } = await import("./dev.ts");
    return executeDev({ cwd, port: args.port, watch: args.watch });
  },
});

const start = defineExec({
  meta: { name: "start", description: "Serve the built agent (production)" },
  args: {
    port: { type: "string", alias: "p", description: "Port to listen on" },
    host: { type: "string", description: "Address to bind (default: loopback)" },
    json: sharedArgs.json,
  },
  // Like dev/build/publish: a directory with no `agent.ts` is not a project to
  // serve, and the alternative is a server that boots and answers 404 for the
  // one thing it exists for.
  cwd: "agent",
  async run({ args, cwd }) {
    const { executeStart } = await import("./start.ts");
    // Parsed here rather than in the executor, so a non-numeric value fails as
    // a CLI error naming the flag — the same rule `aai workflow --limit` follows.
    return executeStart({
      cwd,
      // `omitEmpty` on HOST rather than a truthiness guard: an empty `--host=`
      // means unset, not "every interface", which is the one value here whose
      // falsy reading would widen the bind. `parsePort` already refuses "".
      ...omitUndefined({
        port: args.port === undefined ? undefined : parsePort(args.port),
        host: args.host?.trim() || undefined,
      }),
    });
  },
});

const test = defineExec({
  meta: { name: "test", description: "Run agent tests" },
  args: {
    json: sharedArgs.json,
    // The widening `executeTest`'s own `incomplete_run` failure recommends.
    // Without it declared here `assertKnownArgv` rejects the very flag that
    // error tells the reader to run.
    all: {
      type: "boolean",
      description: "Run every spec in the project, not just agent.test.ts",
    },
  },
  // Like dev/build/push/publish. This command shipped once WITHOUT the agent
  // gate, and that is the incident `defineExec`'s `cwd` field exists for: in a
  // directory with no agent.ts it found no test file, reported
  // `{ passed: true, skipped: true }` and exited 0 — a green result for a
  // project that is not there, which in CI reads as a passing suite.
  cwd: "agent",
  async run({ args, cwd }) {
    const { executeTest } = await import("./test.ts");
    return executeTest(cwd, { all: args.all === true });
  },
});

const evalCommand = defineExec({
  meta: { name: "eval", description: "Run agent behaviour evals against a live model" },
  args: {
    json: sharedArgs.json,
  },
  // Same gate as `test`, for the same reason: in a directory with no agent.ts
  // there is nothing to evaluate, and a `{ passed: true, skipped: true }` for a
  // project that is not there reads as a passing run.
  cwd: "agent",
  async run({ cwd }) {
    const { executeEval } = await import("./eval.ts");
    return executeEval(cwd);
  },
});

const build = defineExec({
  meta: { name: "build", description: "Bundle agent without deploying" },
  args: {
    json: sharedArgs.json,
    skipTests: { type: "boolean", description: "Skip running tests before build" },
    skipTypecheck: { type: "boolean", description: "Skip type checking before build" },
    // No `default`, deliberately: absence is what leaves the host-environment
    // detection in charge, and a default here would make the flag the only way
    // to reach any target but `node`.
    target: {
      type: "string",
      description: "Deployment shape to emit (node, vercel; default: detected)",
    },
  },
  cwd: "agent",
  async run({ args, cwd }) {
    const { executeBuild } = await import("./build.ts");
    return executeBuild({
      cwd,
      skipTests: args.skipTests,
      skipTypecheck: args.skipTypecheck,
      target: args.target,
    });
  },
});

// INTERNAL: the raw bundle-upload path. Not a user command — the studio's
// Publish route runs it inside the project's sandbox (aai-guest/
// studio-publish.ts), which is the only production deploy path. Users go
// through `aai publish`.
const deploy = defineExec({
  meta: { name: "deploy", description: "(internal) used by studio Publish", hidden: true },
  args: {
    ...platformArgs,
    allowPreviewSlug: {
      type: "boolean",
      description:
        "Permit a `-preview`-suffixed slug (reserved for studio auto-previews; " +
        "studio-internal — a slug you claim this way is subject to the preview reaper)",
    },
    skipTypecheck: { type: "boolean", description: "Skip type checking before deploy" },
  },
  cwd: "agent",
  async run({ args, cwd }) {
    const { executeDeploy } = await import("./deploy.ts");
    return executeDeploy({
      cwd,
      server: args.server,
      allowPreviewSlug: args.allowPreviewSlug,
      skipTypecheck: args.skipTypecheck,
    });
  },
});

const del = defineExec({
  meta: {
    name: "delete",
    description: "Delete the studio project and its deployed agents",
  },
  args: {
    ...platformArgs,
  },
  // The link in `.aai/project.json` is what it deletes; a directory that has
  // lost its agent.ts can still own a studio project.
  cwd: "any",
  async run({ args, cwd }) {
    const { executeDelete } = await import("./delete.ts");
    return executeDelete({ cwd, server: args.server });
  },
});

const login = defineExec({
  meta: { name: "login", description: "Link your signed-in browser account and save your API key" },
  args: {
    ...platformArgs,
  },
  // Account-level, not project-level: it works from anywhere.
  cwd: "none",
  async run({ args }) {
    const { executeLogin } = await import("./login.ts");
    return executeLogin({ server: args.server });
  },
});

const templates = defineExec({
  meta: { name: "templates", description: "List available project templates" },
  args: {
    json: sharedArgs.json,
  },
  // Reads the CLI's own bundled templates; the working directory is irrelevant.
  cwd: "none",
  async run({ mode }) {
    const { listTemplates } = await import("./_templates.ts");
    const names = await listTemplates();
    if (mode === "human") {
      for (const name of names) log.message(name);
      log.info("Scaffold one with `aai init --template <name>`.");
    }
    return { ok: true, data: { templates: names } };
  },
});

export const mainCommand = defineCommand({
  // `mainMeta`, not a spread of it: spreading would READ the getter here and
  // put the file read back on module load, which is the thing it removes.
  meta: mainMeta,
  subCommands: {
    init,
    dev,
    start,
    test,
    eval: evalCommand,
    build,
    list,
    pull,
    push,
    publish,
    deploy,
    delete: del,
    login,
    secret,
    logs,
    workflow,
    templates,
  },
});

if (process.env.VITEST !== "true") {
  // JSON mode writes to stdout, which may be a pipe whose consumer exits
  // early (`aai … --json | head -1`) — EPIPE must not crash with a raw stack.
  installStdoutGuard();

  // A default command is injected ONLY on a truly bare `aai` — a leading
  // flag no longer counts as "no subcommand". It used to, which meant a
  // typo like `aai -v` or `aai --hlep` in a deployed project silently
  // became `deploy <flag>` and pushed to production.
  const runDefault = async (): Promise<void> => {
    if (process.argv.length > 2) return;
    if (!existsSync(path.join(resolveCwd(), AGENT_ENTRY))) {
      process.argv.splice(2, 0, "init");
      return;
    }
    // Publishing is an outward-facing act (it syncs source to the studio
    // and deploys to production) — when there's a human at the terminal,
    // make sure a bare `aai` (often "what does this do?") means it. Non-TTY
    // keeps the implicit behavior: scripts invoking bare `aai` are deliberate.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const p = await import("@clack/prompts");
      const confirmed = await p.confirm({ message: "Publish this agent to production?" });
      if (confirmed !== true) {
        log.info("Cancelled. Run `aai --help` to see all commands.");
        process.exit(0);
      }
    }
    process.argv.splice(2, 0, "publish");
  };

  /**
   * Render usage the way the active output mode allows.
   *
   * citty calls `showUsage` from two places: the `--help` path, and its
   * `catch` for a `CLIError` (a missing positional, an unknown subcommand) —
   * where it writes the usage block to STDOUT and the reason to stderr. That
   * second one breaks JSON mode's contract of exactly one result line on
   * stdout, and JSON mode is auto-detected on a pipe: `aai secret put --json`
   * put a usage block where a script's `jq` expected a result, with no JSON
   * emitted at all. Every other failure path in this CLI converges on one
   * emitter and gets this right.
   *
   * `--help` is explicitly still the human block whatever the mode — piping
   * it into a pager is the normal way to read it, and it is not an error.
   * The specific reason keeps going to stderr as citty already writes it, so
   * nothing is lost to a human watching the terminal.
   */
  const usageForMode: typeof showUsage = async (cmd, parent) => {
    const argv = process.argv.slice(2);
    const wantsHelp = argv.includes("--help") || argv.includes("-h");
    if (wantsHelp || getOutputMode({}) === "human") {
      await showUsage(cmd, parent);
      return;
    }
    const named = commandPath(cmd, parent);
    await writeLine(
      `${JSON.stringify(
        fail(
          "usage",
          `Invalid arguments for \`${named}\`.`,
          `Run \`${named} --help\` to see the arguments it accepts.`,
        ),
      )}\n`,
    );
  };

  /**
   * Report a pre-parse failure the way the active output mode allows, then
   * exit 1.
   *
   * Mode-aware for the same reason `usageForMode` is: JSON mode promises
   * exactly one result line on stdout, and it is auto-detected on a pipe —
   * so a clack block here left `aai push --json --serverr=x` emitting a
   * human error where a script's `jq` expected a result, and no JSON at all.
   * The guards below run BEFORE citty parses, so neither can lean on
   * `defineExec`'s mode plumbing.
   */
  const reportAndExit = async (label: string, hint: string): Promise<never> => {
    if (getOutputMode({}) === "json") {
      await writeLine(`${JSON.stringify(fail("usage", label, hint))}\n`);
    } else {
      log.error(label);
      log.info(hint);
    }
    process.exit(1);
  };

  /**
   * Refuse a mistyped command or an unrecognized flag instead of letting
   * either through — both read off ONE walk of the command tree.
   *
   * An unknown SUBCOMMAND is answered here rather than by citty, which throws
   * `Unknown command ${cyan(name)}` and writes it with `console.error` —
   * colour escapes and all, whatever the output mode and whether or not stderr
   * is a terminal — AFTER `showUsage` has already emitted the result line. So
   * `aai deploy-now | jq` produced an envelope that named `aai` instead of the
   * token the user typed, plus an ANSI-studded sentence on stderr that no JSON
   * consumer asked for. Reported here instead: the envelope names the command,
   * and nothing colours a pipe.
   *
   * An unknown FLAG is refused because citty drops one silently, so
   * `aai push --serverr=http://x` exited 0 having pushed to the DEFAULT server.
   * `--server` decides where the API key and secret values go, so a typo that
   * quietly retargets it is worth failing on.
   *
   * The command check comes first because a flag can only be judged against
   * the right command's `argsDef` — which is why `resolveArgv` reports the two
   * together instead of leaving the order to this call site.
   */
  const assertKnownArgv = async (): Promise<void> => {
    const { named, unknownCommand, argsDef, rest } = await resolveArgv(
      mainCommand,
      process.argv.slice(2),
    );
    if (unknownCommand !== undefined) {
      await reportAndExit(
        `Unknown command: ${unknownCommand}`,
        `Run \`${named.join(" ")} --help\` to see the commands it accepts.`,
      );
    }
    const unknown = findUnknownFlags(rest, argsDef);
    if (unknown.length === 0) return;
    const label = `Unknown ${plural(unknown.length, "option")}: ${unknown.join(", ")}`;
    await reportAndExit(label, "Run `aai <command> --help` to see the options it accepts.");
  };

  // API key acquisition happens inside the platform commands, after citty
  // parses args — so --help/--version never prompt for a key.
  void runDefault()
    .then(assertKnownArgv)
    .then(() => runMain(mainCommand, { showUsage: usageForMode }))
    .catch((err: unknown) => {
      log.error(errorMessage(err));
      process.exitCode = 1;
    });
}
