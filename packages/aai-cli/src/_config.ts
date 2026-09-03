// Copyright 2025 the AAI authors. MIT license.

import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sleep } from "@alexkroman1/aai/internal";
import envPaths from "env-paths";
import { z } from "zod";
import { CliError } from "./_output.ts";
import { errorMessage, isEexist, readJson, writeJson } from "./_utils.ts";

/**
 * `.aai/project.json` lives in the working tree, so everything in it is
 * untrusted input — a cloned repo can supply any value.
 *
 * `serverUrl` is deliberately NOT validated here. A failed field makes
 * `readProjectConfig` return null for the whole file, which discards the
 * `slug` too — and a deploy with no slug generates a fresh one, silently
 * creating a duplicate agent and overwriting the config. The URL is instead
 * validated where it is used, by `resolveServerUrl`, which rejects anything
 * that isn't an approved http(s) origin.
 */
const ProjectConfigSchema = z.object({
  /** Deployed agent slug — absent for a pulled project never published. */
  slug: z.string().optional(),
  serverUrl: z.string(),
  /** Studio project this directory is linked to (`aai pull`/`aai push`). */
  studioProject: z.string().optional(),
  /**
   * The workspace files hash at the last pull/push — `aai push` sends it
   * back as the fast-forward token, so an edit made in the studio since
   * then surfaces as a 409 instead of being silently overwritten.
   */
  studioSourceHash: z.string().optional(),
});

/**
 * Resolve the global config directory (the platform-conventional env-paths
 * location).
 *
 * `AAI_CONFIG_DIR` overrides everything — it exists so tests (and unusual
 * setups) can redirect ALL global-config reads and writes away from the
 * user's real config. The test suite's `approveServer` calls used to
 * permanently pollute `~/.config/aai/config.json` with approved origins.
 */
export function getConfigDir(): string {
  const override = process.env.AAI_CONFIG_DIR?.trim();
  if (override) return override;
  // Fail-closed under vitest: never hand back the developer's real config
  // dir. Any test reaching approveServer/ensureApiKey without an explicit
  // AAI_CONFIG_DIR would otherwise write there, and that file is the trust
  // anchor for `serverUrl` in `.aai/project.json` — an approved origin
  // leaked into it lets a cloned repo receive the developer's API key and
  // `aai secret` values with no prompt (see `resolveServerUrl`).
  //
  // This guard is in the code path rather than a vitest setup file because
  // setup files are per-config and any config can omit one:
  // `vitest.slow.config.ts` (the integration/e2e config) declared none, so
  // `_test-setup.ts` never ran for those suites and real configs
  // accumulated ~100 approved loopback origins plus `https://override.com`.
  // Spawned CLI children run with VITEST cleared, so the e2e harness sets
  // AAI_CONFIG_DIR itself (`aaiEnv` in _e2e-test-utils.ts) — both halves are
  // needed.
  if (process.env.VITEST) return testConfigDir();
  return envPaths("aai", { suffix: "" }).config;
}

/**
 * Per-process throwaway config dir used only under vitest. Memoized: callers
 * read-modify-write the same config across calls, so a fresh dir per call
 * would silently drop what the previous one wrote.
 */
let _testConfigDir: string | undefined;
function testConfigDir(): string {
  _testConfigDir ??= mkdtempSync(path.join(tmpdir(), "aai-vitest-config-"));
  return _testConfigDir;
}

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export async function readProjectConfig(agentDir: string): Promise<ProjectConfig | null> {
  const file = path.join(agentDir, ".aai", "project.json");
  let data: unknown;
  try {
    data = await readJson(file);
  } catch (err) {
    // A corrupted project.json must not read as "never deployed": a deploy
    // with no slug generates a fresh one, orphaning the live deployment.
    const reason = errorMessage(err).replace(`Invalid JSON in ${file}: `, "");
    throw new Error(
      `project.json is corrupted at ${file}: ${reason}\n` +
        "  Fix or delete the file — deploying without it would create a new agent under a fresh slug.",
      { cause: err },
    );
  }
  if (data === null) return null;
  const parsed = ProjectConfigSchema.safeParse(data);
  // Schema failure reads as "never deployed" (see the schema doc comment) —
  // deliberately quiet, since the URL is trust-checked where it is used.
  if (!parsed.success) return null;
  return parsed.data;
}

export async function writeProjectConfig(agentDir: string, data: ProjectConfig): Promise<void> {
  await writeJson(path.join(agentDir, ".aai", "project.json"), data);
}

/**
 * Merge `patch` into the existing project config rather than replacing the
 * file — a publish recording its `slug` must not drop the studio link
 * fields a pull wrote, and vice versa.
 */
export async function updateProjectConfig(
  agentDir: string,
  patch: Partial<ProjectConfig> & Pick<ProjectConfig, "serverUrl">,
): Promise<ProjectConfig> {
  let existing: ProjectConfig | null = null;
  try {
    existing = await readProjectConfig(agentDir);
  } catch {
    // Corrupted file: the patch's full values replace it (the read-throw
    // exists to protect DEPLOY from minting a fresh slug, not updates that
    // carry their own slug/link state).
  }
  const merged = { ...existing, ...patch };
  await writeProjectConfig(agentDir, merged);
  return merged;
}

export type GlobalConfig = {
  apiKey?: string;
  /**
   * Origins the user has explicitly pointed the CLI at with `--server`.
   *
   * Lives in the user-owned global config, never in the repo: it is what makes
   * a `serverUrl` from `.aai/project.json` trustworthy enough to receive an
   * API key. See `resolveServerUrl`.
   */
  approvedServers?: string[];
};

/**
 * Origin of `url`, or `null` when it is not an absolute http(s) URL.
 *
 * Non-HTTP schemes are rejected rather than returned: `new URL()` yields the
 * opaque origin `"null"` for them, which would otherwise flow on as if it
 * were a real origin.
 */
export function serverOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
}

/** Bounded so a stuck lock degrades to the old racy write, never a hang. */
const CONFIG_LOCK_TIMEOUT_MS = 2000;
const CONFIG_LOCK_RETRY_MS = 20;
/** Older than this and the holder is assumed dead (crashed mid-update). */
const CONFIG_LOCK_STALE_MS = 10_000;

/**
 * Serialize a read-modify-write of the global config ACROSS PROCESSES.
 *
 * `writeJson` makes each individual write atomic, so no reader ever sees a
 * torn file — but the read→modify→write SPAN is not atomic, and every writer
 * here replaces the whole document. Two concurrent CLI invocations therefore
 * lose each other's updates: measured on this repo, 8 parallel commands each
 * approving a distinct origin recorded only 5 of them, and — the case that
 * matters — a concurrent `approveServer` straddling the final write of
 * `aai login` DISCARDS THE API KEY the login just reported saving, leaving
 * the next command with `not_logged_in`. That window is wide open in practice:
 * `aai login` polls for up to five minutes while the user approves in the
 * browser, so any other command run in that time can be mid-update when the
 * key lands.
 *
 * The lock is a `wx` (exclusive-create) lockfile — atomic on every platform
 * we target, and the only primitive available across processes without a
 * daemon. Three deliberate properties:
 *
 * - **Acquisition is bounded** (`CONFIG_LOCK_TIMEOUT_MS`). On timeout the
 *   update proceeds UNLOCKED rather than throwing: these are small
 *   convenience files, and failing `aai login` because a lockfile is stuck
 *   would be strictly worse than the lost update the lock exists to prevent.
 * - **A stale lock is broken** (`CONFIG_LOCK_STALE_MS`). A process killed
 *   mid-update leaves the file behind; without this, one crash would make
 *   every later config write take the unlocked path forever.
 * - **Never nest.** Re-entering from inside `fn` would self-deadlock until the
 *   timeout. `executeLogin` calls `approveServer` and the key update in
 *   sequence, not nested — keep it that way.
 */
async function withGlobalConfigLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(dir, "config.lock");
  const held = await acquireConfigLock(dir, lockPath);
  try {
    return await fn();
  } finally {
    if (held) await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

/** True when this process created the lockfile; false means "proceed unlocked". */
async function acquireConfigLock(dir: string, lockPath: string): Promise<boolean> {
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      // "wx" fails when the file exists — the atomic test-and-set.
      await (await fs.open(lockPath, "wx", 0o600)).close();
      return true;
    } catch (err) {
      if (!isEexist(err)) return false; // unlockable; proceed
      if (!(await contendForLock(lockPath, deadline))) return false;
    }
  }
}

/**
 * One turn of the contention loop: break the lock if it is stale, otherwise
 * wait a beat. False means STOP — the deadline passed, or the lock cannot be
 * broken at all.
 *
 * That second case is the one worth naming. `fs.rm`'s `force` masks only
 * ENOENT and there is no `recursive`, so an entry that is not an ordinary file
 * — a `config.lock` DIRECTORY, an immutable or permission-denied file — makes
 * the removal throw every time. Swallowing that throw and looping restarted
 * the loop ABOVE the deadline check, so `aai login` (and every `--server`
 * invocation) spun in a tight async loop with no output and no exit: bounded
 * acquisition, the contract stated above, held in every case except the one
 * where breaking the lock is impossible. The removal's OUTCOME is what decides
 * whether looping is progress.
 */
async function contendForLock(lockPath: string, deadline: number): Promise<boolean> {
  const age = await fs
    .stat(lockPath)
    .then((s) => Date.now() - s.mtimeMs)
    .catch(() => 0);
  if (age > CONFIG_LOCK_STALE_MS) {
    const broken = await fs.rm(lockPath, { force: true }).then(
      () => true,
      () => false,
    );
    return broken && Date.now() < deadline;
  }
  if (Date.now() >= deadline) return false;
  await sleep(CONFIG_LOCK_RETRY_MS);
  return true;
}

/**
 * Apply `update` to the global config under the cross-process lock, re-reading
 * inside it so the merge is against current contents rather than a snapshot
 * taken before the lock was held. Every read-modify-write of the global config
 * must go through this — a direct `readGlobalConfig`/`writeGlobalConfig` pair
 * is the bug this exists to prevent.
 *
 * Returning the argument unchanged skips the write, so the common no-op case
 * (an origin already approved — i.e. most `--server` invocations) costs a read
 * rather than a rewrite plus the lock contention that comes with it.
 */
export async function updateGlobalConfig(
  update: (current: GlobalConfig) => GlobalConfig,
  configDir?: string,
): Promise<void> {
  const dir = configDir ?? getConfigDir();
  await withGlobalConfigLock(dir, async () => {
    const current = await readGlobalConfig(dir);
    const next = update(current);
    if (next !== current) await writeGlobalConfig(dir, next);
  });
}

/**
 * Record `url`'s origin as user-approved, so later commands in this project
 * may send credentials there without re-passing `--server`.
 */
export async function approveServer(url: string, configDir?: string): Promise<void> {
  const origin = serverOrigin(url);
  if (!origin) return;
  await updateGlobalConfig((config) => {
    const approved = config.approvedServers ?? [];
    return approved.includes(origin)
      ? config
      : { ...config, approvedServers: [...approved, origin] };
  }, configDir);
}

export async function readGlobalConfig(configDir?: string): Promise<GlobalConfig> {
  const dir = configDir ?? getConfigDir();
  return ((await readJson(path.join(dir, "config.json"))) as GlobalConfig | null) ?? {};
}

export async function writeGlobalConfig(configDir: string, data: GlobalConfig): Promise<void> {
  // config.json holds the plaintext API key — owner-only, like ~/.aws or
  // ~/.npmrc. The mode rides the atomic-rename temp file, so an existing
  // world-readable config from an older CLI is tightened on the next write.
  await writeJson(path.join(configDir, "config.json"), data, { mode: 0o600 });
}

/**
 * Why the caller wants the key, which is what the FAILURE has to answer.
 *
 * One source, two questions. `"platform"` asks "who is this CLI logged in
 * as?" — for `publish`/`push`/`logs`/`secret` a platform account genuinely IS
 * the requirement, so the refusal is account-shaped and points at
 * `aai login`. `"local-session"` is `aai dev` asking for a PROVIDER
 * credential that the logged-in account merely happens to be able to supply:
 * `ASSEMBLYAI_API_KEY` in `.env`, or exported in the shell, starts the same
 * server with no account anywhere (see `resolveAgentEnv` in `_dev-server.ts`,
 * which reaches here only when neither carries one).
 *
 * Answering the second question with the first's sentence is the defect this
 * parameter exists to fix: `not_logged_in` names only account remedies
 * (`aai login`, `AAI_CONFIG_DIR`), so `aai dev` read as "local development is
 * gated on a cloud account" — and most of a twenty-persona DX audit believed
 * it and abandoned the documented primary feedback loop, which was never
 * gated at all.
 *
 * A PARAMETER rather than a second exported function because the source is
 * shared: both answers must keep reading the one slot `aai login` writes, and
 * a sibling function is how the two come to disagree about where a key lives.
 */
export type ApiKeyUse = "platform" | "local-session";

/** Local-session remedies FIRST — the two that need no account at all. */
const LOCAL_SESSION_HINT =
  "Any ONE of these is enough, and the first two need no aai account:\n" +
  "  1. Put ASSEMBLYAI_API_KEY=<your key> in this project's .env — the same file `aai publish` uploads.\n" +
  "  2. Or export it in your shell: export ASSEMBLYAI_API_KEY=<your key>\n" +
  "  3. Or run `aai login`, and `aai dev` will use your account's key.\n" +
  "Get a key at https://www.assemblyai.com/dashboard.";

/**
 * The credential every platform command runs on.
 *
 * ONE source: the key `aai login` saved to the global config. Nothing else
 * authenticates the CLI.
 *
 * There is deliberately no "paste a key" prompt and no `ASSEMBLYAI_API_KEY`
 * fallback. Both produced the same half-configured CLI — able to push,
 * publish, and read/write another account's secrets while linked to no
 * account the user could see in the studio — and both made `aai login`, the
 * real onboarding path, optional in practice. The env var was the worse of
 * the two: it applies to every invocation in a shell, it silently PERSISTED
 * itself into the global config on first use (so the CLI stayed authenticated
 * as that key long after the export was gone), and it collides with the
 * variable the same name serves in a project `.env`, where it is a *provider*
 * credential for the local dev server rather than a platform identity.
 *
 * Non-interactive callers (CI, scripts, the eval harnesses) authenticate by
 * pointing `AAI_CONFIG_DIR` at a config dir holding a key from an interactive
 * `aai login`.
 */
export async function ensureApiKey(
  configDir?: string,
  use: ApiKeyUse = "platform",
): Promise<string> {
  const dir = configDir ?? getConfigDir();
  const config = await readGlobalConfig(dir);
  if (config.apiKey) return config.apiKey;

  // Credential-shaped question, credential-shaped answer — see {@link ApiKeyUse}.
  if (use === "local-session") {
    throw new CliError(
      "missing_assemblyai_key",
      "ASSEMBLYAI_API_KEY is not set, and this agent's pipeline needs it to start a session.",
      LOCAL_SESSION_HINT,
    );
  }

  throw new CliError(
    "not_logged_in",
    "You're not logged in.",
    "Run `aai login` to link your account. Non-interactive setups can point AAI_CONFIG_DIR at a config dir holding a logged-in key.",
  );
}
