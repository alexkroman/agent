// Copyright 2026 the AAI authors. MIT license.
/**
 * One child-process runner for every guest spawn site — builds, Publish,
 * `bash`, npm, and the workspace test run. Five hand-rolled copies of
 * "spawn → cap each stream to a kept tail → settle on close" had already
 * drifted on signal and cap semantics; the policy differences that remain
 * (reject vs annotate on a kill, combined vs separate streams) are the
 * caller's, decided on the result this returns.
 *
 * stdin is always `ignore`: none of these children read it, and an open
 * pipe the parent never writes lets a child like a bare `cat` block until
 * the timeout instead of seeing EOF.
 */

import { spawn } from "node:child_process";
import { omitUndefined } from "@alexkroman1/aai/utils";

/** Output tail kept per stream from a CLI child (build / deploy envelopes). */
export const CLI_OUTPUT_CAP = 32_000;

export type SpawnCappedResult = {
  exitCode: number | null;
  /** Set when the child was killed — usually the wall-clock timeout. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/** Keep the tail of `text`, marking the elision — errors print last. */
export const keepTail = (text: string, cap: number): string =>
  text.length > cap ? `…${text.slice(-cap)}` : text;

/**
 * Run one child process, capturing capped output tails. Rejects only when
 * the process could not be spawned; a killed child resolves with `signal`
 * set so the caller picks the failure shape its output contract needs.
 * With `combineStreams`, stderr interleaves into `stdout` in arrival order
 * (the shell-tool shape) and `stderr` comes back empty.
 */
export function runCapped(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    /** Child env; defaults to this process's. */
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    /** Tail kept per captured stream. */
    cap: number;
    combineStreams?: boolean;
  },
): Promise<SpawnCappedResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      ...omitUndefined({ env: opts.env }),
      timeout: opts.timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keepTail(stdout + chunk.toString(), opts.cap);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (opts.combineStreams) stdout = keepTail(stdout + chunk.toString(), opts.cap);
      else stderr = keepTail(stderr + chunk.toString(), opts.cap);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

/**
 * The child's stdout with a KILL annotated onto it — the shape every surface
 * that returns one string to the model shares (`bash`, the npm tools, the
 * workspace test run). `runCapped` leaves the policy to the caller and reports
 * `signal`; what was copied three times was this sentence, not the decision.
 */
export function outputWithKillNote(result: SpawnCappedResult, timeoutMs: number): string {
  return result.signal
    ? `${result.stdout}\n[killed by ${result.signal} after ${timeoutMs}ms]`
    : result.stdout;
}

/** Wall-clock limit for one npm invocation. */
export const NPM_TIMEOUT_MS = 110_000;

/** Output tail kept from npm (errors print last). */
export const NPM_OUTPUT_CAP = 4000;

/**
 * npm package NAME: optional scope, then the name. No version part.
 *
 * Shared rather than per-caller because it is npm's vocabulary, not any one
 * tool's policy — it was written out twice, byte for byte, in
 * `studio-project-tools.ts` and `studio-workspace-deps.ts`.
 */
export const PACKAGE_NAME_RE = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/;

/**
 * Run one npm command with this package's standing flags and policy.
 *
 * Every npm spawn in the guest goes through here. It existed twice — once in
 * `studio-project-tools.ts` for the dependency tools and once inline in
 * `studio-workspace-deps.ts` — and the copies had ALREADY drifted on how a
 * killed child reads, which is the exact failure this module's header says it
 * was created to end. `signal` stays on the result so a caller can still
 * choose its own wording; what is shared is the flag tail, the env, the
 * default timeout and the cap. `timeoutMs` overrides the default for a caller
 * spending one budget across several runs.
 */
export function runNpm(
  dir: string,
  args: string[],
  timeoutMs = NPM_TIMEOUT_MS,
): Promise<SpawnCappedResult> {
  return runCapped("npm", [...args, "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: dir,
    env: workspaceChildEnv(),
    timeoutMs,
    cap: NPM_OUTPUT_CAP,
    combineStreams: true,
  });
}

/** The last non-empty stdout line parsed as JSON — the one-line envelope
 * contract the build child and the CLI's `--json` mode share. */
export function parseLastJsonLine<T>(stdout: string): T | null {
  const line = stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/**
 * The ambient machine configuration a child that runs workspace-authored code
 * may see.
 *
 * ## Why this is an ALLOW-list
 *
 * It was `{ ...process.env }` minus `AAI_GUEST_TOKEN` — a deny-list of one, and
 * COMPLETE when it was written: `AAI_GUEST_TOKEN` really was the only secret in
 * the studio guest's exec env (`modal-sandbox.ts` passes that token, the port,
 * and `guestExecBaseEnv()`, which is a cache path and a flag). The problem is
 * the polarity, not the contents. Agent mode's boot env already carries
 * `AAI_BUNDLE_URL` — a signed Storage URL — plus `AAI_PLATFORM_BASE_URL` and
 * `AAI_AGENT_ENV_PATH`, so the next boot key added on the studio side defaults
 * INTO `bash`, `npm` and the workspace test run with no diff for a reviewer to
 * catch. Under `SANDBOX_BACKEND=subprocess` the same deny-list hands workspace
 * code the whole DEVELOPER environment, `SUPABASE_SERVICE_ROLE_KEY` and
 * `ANTHROPIC_API_KEY` included.
 *
 * {@link cliChildEnv} two functions down is already the allow-list shape and is
 * what the in-guest deploy child takes. This is the same idea widened by
 * exactly what a `bash` and an `npm install` genuinely need — breaking
 * `npm install` in a studio workspace would be worse than the risk being
 * closed, so every entry below is here for a named reason rather than for
 * safety's sake.
 *
 * ## No PREFIX matching, deliberately
 *
 * The obvious shortcut is `npm_config_*`, and it is exactly wrong: npm's own
 * credentials live in that namespace (`npm_config__authToken`,
 * `npm_config__auth`). A prefix rule would re-open the hole through the very
 * mechanism meant to close it, so the proxy variables are named one at a time.
 * `AAI_*` gets no prefix rule for the mirror-image reason — two names are
 * allowed BY NAME below and every other one, present or future, is out.
 *
 * ## What is deliberately NOT here
 *
 * - **`NODE_ENV`.** `production` makes `npm install` skip devDependencies, so
 *   inheriting it decided whether a workspace could run its own tests based on
 *   how the server happened to be started. Absent, the install is deterministic.
 * - **Every credential**, obviously, but also every value that merely LOOKS
 *   ambient and names a platform capability: `AAI_BUNDLE_URL`,
 *   `AAI_PLATFORM_BASE_URL`, `AAI_AGENT_ENV_PATH`, `AAI_PUBLIC_BASE_URL`,
 *   `AAI_WORKFLOW_API_TOKEN`, `AAI_GUEST_TOKEN`, `AAI_GUEST_PORT`.
 * - **`USER` / `LOGNAME` / `HOSTNAME`.** Nothing here reads them; `bash` and
 *   `npm` ask the OS.
 *
 * This is defence in depth rather than a boundary either way — `bash` can read
 * `/proc/1/environ` — but a boundary is not what it claims to be. The claim is
 * that adding a boot key does not silently widen what workspace code is handed.
 *
 * The one READER is {@link workspaceChildEnv}, which is what every spawn site
 * calls; this list is the policy and that function is the copy. The pointer is
 * spelled out because the reader used to be named `envWithoutGuestToken`, i.e.
 * after the deny-list-of-one it replaced — so the function name was carrying the
 * explanation of the SHAPE, and carrying the wrong one. Neither name has to now:
 * an entry added below is the whole of what changes.
 */
export const WORKSPACE_CHILD_ENV_ALLOWLIST: readonly string[] = [
  // ── Without these the child does not run ──────────────────────────────────
  // Resolves `npm`, `bash`, and everything a bash command invokes.
  "PATH",
  // npm's userconfig (`~/.npmrc`) and cache (`~/.npm`), and `~` in bash.
  "HOME",
  // ── Ambient machine config: the set turbo.json's `globalPassThroughEnv`
  //    already treats as machine-level, minus its secrets and its own knobs ──
  // Stripped, `os.tmpdir()` falls back to a shared `/tmp` — and `npm prefix`
  // walks up for the nearest `package.json` or `node_modules`, so a stray
  // `/tmp/node_modules` makes npm report `/tmp` instead of the workspace. That
  // is a real flake this repo has already paid for once; see the note on
  // `runs in the directory it is given` in `studio-spawn.test.ts`.
  "TMPDIR",
  "TMP",
  "TEMP",
  // Egress config. A deployment behind a proxy or a private CA needs all of
  // these or `npm install` fails with a misleading resolution error.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "npm_config_proxy",
  "npm_config_https_proxy",
  "npm_config_noproxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // ── Locale and terminal: absence changes OUTPUT, and occasionally more ─────
  // A C-locale child mangles non-ASCII filenames and tool output.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // Some tools a workspace `bash` command invokes refuse to run without it.
  "TERM",
  // Progress bars and colour off, which is what a captured, capped tail wants.
  // `studio-test.ts` sets it explicitly for vitest; this keeps `npm` and a
  // workspace `bash` script consistent with it.
  "CI",
  // ── The two AAI_/NODE_ names allowed BY NAME, both non-credentials ─────────
  // The V8 compile cache the guest image bakes. A path, and the child node
  // processes (the workspace test run is `process.execPath`) are what it exists
  // to speed up.
  "NODE_COMPILE_CACHE",
  // `AAI_SANDBOX_CONTAINED` (`CONTAINED_ENV`) — the statement "a real sandbox
  // surrounds this process", which is equally true of a child of it. It selects
  // the SDK's pinned fetch over the SSRF-screening one, so dropping it would
  // make a workspace test that talks to a local mock server start failing for a
  // reason that has nothing to do with the test. Not a credential: the
  // container is the boundary, and this repo relies on no in-process capability
  // stripping.
  "AAI_SANDBOX_CONTAINED",
];

/**
 * The ambient env for children that run workspace-controlled code (`bash`, npm,
 * the workspace test run) — an ALLOW-LIST, so the control-channel bearer and
 * every future boot key are out by default rather than by remembering.
 *
 * See {@link WORKSPACE_CHILD_ENV_ALLOWLIST} for what is allowed and why.
 *
 * It was `envWithoutGuestToken`, which named the deny-list-of-one this replaced —
 * `process.env` minus `AAI_GUEST_TOKEN`. That name went on describing an
 * implementation the function no longer had, and the reading it invited is the
 * one the allow-list exists to falsify: that a boot key added later is handed to
 * workspace code unless somebody remembers to subtract it.
 */
export function workspaceChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of WORKSPACE_CHILD_ENV_ALLOWLIST) {
    const value = process.env[name];
    // An absent variable stays ABSENT rather than becoming `undefined`: an own
    // property whose value is `undefined` is coerced to the STRING "undefined"
    // by `spawn`, which is how a child ends up with `TMPDIR=undefined`.
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * The env for a child that runs OUR OWN code and holds no credentials — today
 * exactly one caller, the in-guest `aai deploy` Publish runs (`studio-publish.ts`).
 *
 * ## It was `pathOnlyEnv`, and "nothing but PATH" was one variable too narrow
 *
 * That claim was deliberate and it silently cost the thing `TMPDIR` exists to
 * fix. The CLI's bundler writes its worker into
 * `mkdtemp(join(tmpdir(), "aai-worker-"))` — ~8 MB — and with no `TMPDIR`
 * forwarded, `os.tmpdir()` in that child falls back to `/tmp`, which under the
 * local microVM is a **512 MiB tmpfs charged to guest RAM** (measured:
 * `MemAvailable` fell 508,632 kB across a 512 MiB write there and not at all for
 * the same write to `/var/tmp`). The GUEST is on `/var/tmp`
 * (`aai-server/guest-exec-env.ts`); its Publish child was the one process still
 * on the RAM disk, and nothing in a failure would name the env.
 *
 * `TMP` and `TEMP` ride along because `os.tmpdir()` reads all three in that
 * order: forwarding only the first would let the child resolve a DIFFERENT
 * directory than its parent whenever a deployment sets one of the other two.
 *
 * ## Why not {@link workspaceChildEnv}, and why not its 24 names
 *
 * That list is for children running WORKSPACE-authored code — a `bash` command,
 * an `npm install`, the workspace test run — and is sized by what those genuinely
 * need. This child is the aai CLI, which is ours: it needs no npm userconfig, no
 * locale, no `TERM`, no `CI`, and no `HOME` (Publish hands it an explicit
 * `AAI_CONFIG_DIR`, which is the whole of its configuration).
 *
 * Egress config (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, ...) is the one omission
 * worth naming, because the deploy DOES make a network call. It is left out
 * because inside a contained guest there is nothing to forward: that process's
 * env is its exec env — `guestExecBaseEnv()` plus a token and a port — so those
 * names are unset, and copying them would only widen the `subprocess` backend,
 * where they are the developer's. If a Publish behind a proxy or a private CA
 * ever fails on a misleading resolution error, the names to add are the egress
 * block of {@link WORKSPACE_CHILD_ENV_ALLOWLIST} and this paragraph is the
 * argument they answer.
 */
export function cliChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // PATH resolves whatever the CLI shells out to. The temp names are `os.tmpdir()`'s
  // own precedence list, forwarded together so the child cannot resolve a different
  // scratch directory than the guest around it.
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP"]) {
    const value = process.env[name];
    // ABSENT stays absent: an own property whose value is `undefined` is coerced to
    // the STRING "undefined" by `spawn` — see `workspaceChildEnv`.
    if (value !== undefined) env[name] = value;
  }
  return env;
}
