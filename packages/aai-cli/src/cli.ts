// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { omitUndefined, plural } from "@alexkroman1/aai/utils";
import { defineCommand, runMain, showUsage } from "citty";
import { BUILD_TARGETS } from "./_build-target.ts";
import {
  argvOutputMode,
  builtinWithValue,
  commandPath,
  defineExec,
  findMalformedFlags,
  findUnknownFlags,
  platformArgs,
  resolveArgv,
  sharedArgs,
  wantsVersionElsewhere,
} from "./_cli-common.ts";
import { rootHelp } from "./_help.ts";
import { fail, installStdoutGuard, ok, oweExitCode, resultLine } from "./_output.ts";
import { logs, secret } from "./_resource-commands.ts";
import { list, publish, pull, push } from "./_studio-commands.ts";
import { defaultUi, parsePort } from "./_ui.ts";
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
 * The version, read on FIRST ACCESS rather than at module load: only
 * `--version` and the usage renderer read it, so the file read stays off every
 * other command's startup path. Memoized because usage reads it twice.
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
  async run({ args, mode, ui }) {
    const { executeInit } = await import("./init.ts");
    return executeInit(
      {
        dir: args.dir,
        force: args.force,
        template: args.template,
        // JSON mode is non-interactive — accept defaults as if --yes was passed.
        yes: mode === "json" ? true : args.yes,
      },
      { silent: mode === "json", ui },
    );
  },
});

const dev = defineExec({
  meta: { name: "dev", description: "Start a local development server" },
  args: {
    port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
    // No `default`, deliberately: the absence is what leaves `devWatchEnabled`
    // in charge — the two-TTY test, then `AAI_DEV_WATCH` — and a `default`
    // either way here would make this flag the only way to reach the other
    // answer, breaking both the supervisor that sets the variable and the
    // human who sets nothing.
    watch: {
      type: "boolean",
      description: "Restart on file changes (default at a terminal; AAI_DEV_WATCH=0 disables)",
    },
    tunnel: {
      type: "boolean",
      description: "Expose the server on a cloudflared quick tunnel; its URL becomes PUBLIC_URL",
    },
    "on-public-url": {
      type: "string",
      valueHint: "cmd",
      description:
        "Shell command run with PUBLIC_URL set once the server is up, and with it empty on exit",
    },
    json: sharedArgs.json,
  },
  cwd: "agent",
  async run({ args, cwd, ui }) {
    const { executeDev } = await import("./dev.ts");
    return executeDev(
      {
        cwd,
        port: args.port,
        watch: args.watch,
        tunnel: args.tunnel,
        onPublicUrl: args["on-public-url"],
      },
      { ui },
    );
  },
});

const consoleCommand = defineExec({
  meta: {
    name: "console",
    description: "Talk to the agent through your microphone and speakers",
  },
  args: {
    verbose: { type: "boolean", description: "Print the runtime's session log to stderr" },
  },
  cwd: "agent",
  async run({ args, cwd, mode, ui }) {
    const { executeConsole } = await import("./console.ts");
    return executeConsole({ cwd, verbose: args.verbose, mode, ui });
  },
});

const start = defineExec({
  meta: { name: "start", description: "Serve the built agent (production)" },
  args: {
    port: { type: "string", alias: "p", description: "Port to listen on" },
    host: { type: "string", description: "Address to bind (default: loopback)" },
    workers: {
      type: "string",
      description:
        "Worker processes behind one port: a number, or `auto` for one per CPU core (default: 1, or AAI_WORKERS)",
    },
    "drain-timeout": {
      type: "string",
      description:
        "With --workers: seconds a shutdown lets live calls finish (default: 300, or AAI_DRAIN_TIMEOUT)",
    },
    "max-calls-per-worker": {
      type: "string",
      description:
        "With --workers: calls per worker before new ones get 503 (default: unlimited, or AAI_MAX_CALLS_PER_WORKER)",
    },
    json: sharedArgs.json,
  },
  // Like dev/build/publish: a directory with no `agent.ts` is not a project to
  // serve, and the alternative is a server that boots and answers 404 for the
  // one thing it exists for.
  cwd: "agent",
  async run({ args, cwd, ui }) {
    const { executeStart } = await import("./start.ts");
    const workerOptions = await import("./_start-workers.ts");
    // Parsed here rather than in the executor, so a non-numeric value fails as
    // a CLI error naming the flag — the same rule `aai workflow --limit` follows.
    const workers = workerOptions.resolveWorkers(args.workers);
    // One process neither drains nor caps: it stops on the first signal. Said,
    // because an operator who typed `--drain-timeout` is counting on live calls
    // finishing. Only for a FLAG — a container's env sets these uniformly.
    const workerOnly = ["drain-timeout", "max-calls-per-worker"] as const;
    const ignored = workerOnly.filter((flag) => args[flag] !== undefined);
    if (workers === 1 && ignored.length > 0) {
      const named = ignored.map((flag) => `--${flag}`).join(" and ");
      const verb = ignored.length > 1 ? "apply" : "applies";
      ui.notify(
        "warn",
        `${named} only ${verb} with --workers 2 or more; a single process stops on the first signal.`,
      );
    }
    return executeStart({
      cwd,
      // `omitEmpty` on HOST rather than a truthiness guard: an empty `--host=`
      // means unset, not "every interface", which is the one value here whose
      // falsy reading would widen the bind. `parsePort` already refuses "".
      ...omitUndefined({
        port: args.port === undefined ? undefined : parsePort(args.port),
        host: args.host?.trim() || undefined,
      }),
      workers,
      drainTimeoutMs:
        workerOptions.resolvePositiveInt(
          args["drain-timeout"],
          "--drain-timeout",
          workerOptions.DRAIN_TIMEOUT_ENV,
          workerOptions.DEFAULT_DRAIN_TIMEOUT_S,
          process.env,
          "seconds",
        ) * 1000,
      maxCallsPerWorker: workerOptions.resolvePositiveInt(
        args["max-calls-per-worker"],
        "--max-calls-per-worker",
        workerOptions.MAX_CALLS_ENV,
        Number.POSITIVE_INFINITY,
      ),
    });
  },
});

const test = defineExec({
  meta: { name: "test", description: "Run the project's tests" },
  args: {
    json: sharedArgs.json,
    // The NARROWING, which used to be the default — see `executeTest` for why
    // it stopped being one. The fast inner loop is still worth a flag; a
    // verdict over a subset is not worth a default.
    only: {
      type: "boolean",
      description: "Run agent.test.ts alone, not every spec in the project",
    },
  },
  // Without the agent gate, a directory with no agent.ts reported a green,
  // skipped run — which in CI reads as a passing suite.
  cwd: "agent",
  async run({ args, cwd, ui }) {
    const { executeTest } = await import("./test.ts");
    return executeTest(cwd, { only: args.only === true }, { ui });
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
  async run({ cwd, ui }) {
    const { executeEval } = await import("./eval.ts");
    return executeEval(cwd, { ui });
  },
});

const build = defineExec({
  meta: { name: "build", description: "Bundle agent without deploying" },
  args: {
    json: sharedArgs.json,
    // Kebab-case is the spelling `--help` shows; citty aliases the camelCase
    // one (`--skipTests`), which keeps working, unadvertised.
    "skip-tests": { type: "boolean", description: "Skip running tests before build" },
    "skip-typecheck": { type: "boolean", description: "Skip type checking before build" },
    // No `default`, deliberately: absence is what leaves the host-environment
    // detection in charge, and a default here would make the flag the only way
    // to reach any target but `node`.
    target: {
      type: "string",
      // DERIVED from `BUILD_TARGETS`, never restated: this string is the only
      // place a user learns which targets exist, and a hand-kept copy of a
      // list is the shape that goes stale the first time one is added.
      description: `Deployment shape to emit (${BUILD_TARGETS.join(", ")}; default: detected)`,
    },
  },
  cwd: "agent",
  async run({ args, cwd, ui }) {
    const { executeBuild } = await import("./build.ts");
    return executeBuild(
      {
        cwd,
        skipTests: args["skip-tests"],
        skipTypecheck: args["skip-typecheck"],
        target: args.target,
      },
      { ui },
    );
  },
});

// INTERNAL: the raw bundle-upload path. Not a user command — the studio's
// Publish route runs it inside the project's sandbox (aai-guest/
// studio/publish.ts), which is the only production deploy path. Users go
// through `aai publish`.
const deploy = defineExec({
  meta: { name: "deploy", description: "(internal) used by studio Publish", hidden: true },
  args: {
    ...platformArgs,
    "allow-preview-slug": {
      type: "boolean",
      description:
        "Permit a `-preview`-suffixed slug (reserved for studio auto-previews; " +
        "studio-internal — a slug you claim this way is subject to the preview reaper)",
    },
    "skip-typecheck": { type: "boolean", description: "Skip type checking before deploy" },
  },
  cwd: "agent",
  async run({ args, cwd, ui }) {
    const { executeDeploy } = await import("./deploy.ts");
    return executeDeploy(
      {
        cwd,
        server: args.server,
        allowPreviewSlug: args["allow-preview-slug"],
        skipTypecheck: args["skip-typecheck"],
      },
      ui,
    );
  },
});

const del = defineExec({
  meta: {
    name: "delete",
    description: "Delete the studio project and its deployed agents",
  },
  args: {
    yes: { type: "boolean", alias: "y", description: "Delete without asking for confirmation" },
    ...platformArgs,
  },
  // The link in `.aai/project.json` is what it deletes; a directory that has
  // lost its agent.ts can still own a studio project.
  cwd: "any",
  async run({ args, cwd, ui }) {
    const { executeDelete } = await import("./delete.ts");
    // NOT defaulted to `--yes` in JSON mode the way `init` is: init's prompts
    // pick defaults, this one guards an irreversible delete.
    return executeDelete({ cwd, server: args.server, yes: args.yes }, ui);
  },
});

const login = defineExec({
  meta: { name: "login", description: "Link your signed-in browser account and save your API key" },
  args: {
    ...platformArgs,
  },
  // Account-level, not project-level: it works from anywhere.
  cwd: "none",
  async run({ args, ui }) {
    const { executeLogin } = await import("./login.ts");
    return executeLogin({ server: args.server }, { ui });
  },
});

const templates = defineExec({
  meta: { name: "templates", description: "List available project templates" },
  args: {
    json: sharedArgs.json,
  },
  // Reads the CLI's own bundled templates; the working directory is irrelevant.
  cwd: "none",
  async run({ mode, ui }) {
    const { listTemplates } = await import("./_templates.ts");
    const names = await listTemplates();
    if (mode === "human") {
      for (const name of names) ui.log.message(name);
      ui.log.info("Scaffold one with `aai init --template <name>`.");
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
    console: consoleCommand,
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

/**
 * What a bare `aai` in an agent directory does about publishing, by which of
 * stdin and stdout are terminals.
 *
 * Publishing is an outward-facing act (it syncs source to the studio and
 * deploys to production), so when a human is there a bare `aai` (often "what
 * does this do?") must be confirmed. A terminal on STDIN is what says a human
 * is there; stdout is only where the answer goes. Requiring BOTH to prompt let
 * `aai | tee log` at a terminal publish without asking — so a human whose
 * stdout is piped is refused, and can say `aai publish`. Non-TTY stdin keeps
 * the implicit behaviour: a script invoking bare `aai` is deliberate.
 */
export function bareAaiPublish(tty: {
  stdin: boolean;
  stdout: boolean;
}): "confirm" | "refuse" | "publish" {
  if (!tty.stdin) return "publish";
  return tty.stdout ? "confirm" : "refuse";
}

if (process.env.VITEST !== "true") {
  // JSON mode writes to stdout, which may be a pipe whose consumer exits
  // early (`aai … --json | head -1`) — EPIPE must not crash with a raw stack.
  installStdoutGuard();

  /**
   * Report a pre-parse failure the way the active output mode allows, then
   * exit 1. These guards run BEFORE citty parses, so they cannot lean on
   * `defineExec`'s mode plumbing.
   */
  const reportAndExit = async (label: string, hint: string): Promise<never> => {
    oweExitCode(1);
    if (argvOutputMode(process.argv.slice(2)) === "json") {
      await defaultUi.writeResult(resultLine(fail("usage", label, hint)));
    } else {
      defaultUi.log.error(label);
      defaultUi.log.info(hint);
    }
    process.exit(1);
  };

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
    const action = bareAaiPublish({
      stdin: Boolean(process.stdin.isTTY),
      stdout: Boolean(process.stdout.isTTY),
    });
    if (action === "refuse") {
      await reportAndExit(
        "Not publishing: a bare `aai` deploys to production, and its output is not a terminal to confirm on.",
        "Run `aai publish` to publish explicitly, or `aai --help` to see all commands.",
      );
    }
    if (action === "confirm") {
      const confirmed = await defaultUi.prompts.confirm({
        message: "Publish this agent to production?",
      });
      if (confirmed !== true) {
        defaultUi.log.info("Cancelled. Run `aai --help` to see all commands.");
        process.exit(0);
      }
    }
    process.argv.splice(2, 0, "publish");
  };

  /**
   * Render usage the way the active output mode allows. citty also calls this
   * from its `CLIError` catch (a missing positional), where a usage block on
   * stdout would break JSON mode's one-result-line contract — so a non-help
   * call in JSON mode emits a `usage` failure instead. `--help` is always the
   * human block (piping it to a pager is normal).
   */
  const usageForMode: typeof showUsage = async (cmd, parent) => {
    const argv = process.argv.slice(2);
    const wantsHelp = argv.includes("--help") || argv.includes("-h");
    if (wantsHelp || argvOutputMode(argv) === "human") {
      // Help asked for is a success, which an EPIPE (`aai --help | head -1`)
      // must exit with; citty's own error path sets 1 after this returns.
      if (wantsHelp) oweExitCode(0);
      // The ROOT gets the grouped help (`_help.ts`); a subcommand keeps citty's.
      if ((cmd as unknown) === mainCommand) defaultUi.writeOut(await rootHelp(mainCommand));
      else await showUsage(cmd, parent);
      return;
    }
    const named = commandPath(cmd, parent);
    oweExitCode(1);
    await defaultUi.writeResult(
      resultLine(
        fail(
          "usage",
          `Invalid arguments for \`${named}\`.`,
          `Run \`${named} --help\` to see the arguments it accepts.`,
        ),
      ),
    );
  };

  /**
   * Answer `--version` where citty would not (see `wantsVersionElsewhere`):
   * print it and exit 0 WITHOUT running the command — one result line in
   * JSON mode, the bare version otherwise.
   */
  const printVersionAndExit = async (argv: string[]): Promise<never> => {
    oweExitCode(0);
    const { version } = mainMeta;
    await defaultUi.writeResult(
      argvOutputMode(argv) === "json" ? resultLine(ok({ version })) : `${version}\n`,
    );
    process.exit(0);
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
   * quietly retargets it is worth failing on — and so is a KNOWN flag citty
   * would misread (`findMalformedFlags`: `--no-server`, a valueless `--server`).
   *
   * The command check comes first because a flag can only be judged against
   * the right command's `argsDef` — which is why `resolveArgv` reports the two
   * together instead of leaving the order to this call site.
   */
  const assertKnownArgv = async (): Promise<void> => {
    const argv = process.argv.slice(2);
    const { named, unknownCommand, argsDef, rest } = await resolveArgv(mainCommand, argv);
    if (unknownCommand !== undefined) {
      await reportAndExit(
        `Unknown command: ${unknownCommand}`,
        `Run \`${named.join(" ")} --help\` to see the commands it accepts.`,
      );
    }
    // `aai -- publish`: the root takes no positionals, and citty answered with
    // a stray "No command specified." on stderr.
    if (named.length === 1 && rest.includes("--")) {
      await reportAndExit(
        "`--` cannot come before a command.",
        "Put the command first: `aai <command> [OPTIONS] -- [ARGS]`.",
      );
    }
    const valued = builtinWithValue(argv);
    if (valued !== undefined) {
      const flag = valued.split("=")[0];
      await reportAndExit(
        `${flag} takes no value.`,
        `Pass it bare: \`${named.join(" ")} ${flag}\`.`,
      );
    }
    if (wantsVersionElsewhere(argv)) await printVersionAndExit(argv);
    // Malformed first: in `--limit -5` the `-5` is a would-be VALUE, and
    // "--limit needs a value" says so where "Unknown option: -5" would not.
    const malformed = findMalformedFlags(rest, argsDef);
    if (malformed.length > 0) {
      await reportAndExit(
        `Invalid ${plural(malformed.length, "option")}: ${malformed.join("; ")}`,
        `Run \`${named.join(" ")} --help\` to see the options it accepts.`,
      );
    }
    const unknown = findUnknownFlags(rest, argsDef);
    if (unknown.length > 0) {
      const label = `Unknown ${plural(unknown.length, "option")}: ${unknown.join(", ")}`;
      await reportAndExit(label, "Run `aai <command> --help` to see the options it accepts.");
    }
  };

  // API key acquisition happens inside the platform commands, after citty
  // parses args — so --help/--version never prompt for a key.
  void runDefault()
    .then(assertKnownArgv)
    .then(() => runMain(mainCommand, { showUsage: usageForMode }))
    .catch((err: unknown) => {
      defaultUi.log.error(errorMessage(err));
      process.exitCode = 1;
    });
}
