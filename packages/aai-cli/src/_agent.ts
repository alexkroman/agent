// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VALID_SLUG_RE } from "@alexkroman1/aai/internal";
import {
  approveServer,
  ensureApiKey,
  type GlobalConfig,
  type ProjectConfig,
  readGlobalConfig,
  readProjectConfig,
  serverOrigin,
} from "./_config.ts";
import { stripTrailingSlash } from "./_utils.ts";

export const DEFAULT_SERVER = "https://alexkroman--aai-server-web-server.modal.run";
export const DEFAULT_DEV_SERVER = "http://localhost:8080";

let _cachedMonorepoRoot: string | null | undefined;

export function getMonorepoRoot(): string | null {
  if (_cachedMonorepoRoot !== undefined) return _cachedMonorepoRoot;
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  // Two candidates: the source layout (`packages/aai-cli`) and the published
  // one (`packages/aai-cli/dist`). First match wins, so the nearer workspace
  // root is the one reported.
  _cachedMonorepoRoot =
    ["../..", "../../.."]
      .map((up) => path.resolve(cliDir, up))
      .find((root) => existsSync(path.join(root, "pnpm-workspace.yaml"))) ?? null;
  return _cachedMonorepoRoot;
}

export function isDevMode(): boolean {
  if (process.env.AAI_NO_DEV === "1") return false;
  return getMonorepoRoot() !== null;
}

/**
 * Whether `origin` may receive a credential without prior user approval.
 *
 * Only the shipped platform qualifies. Loopback origins from
 * `.aai/project.json` used to be implicitly trusted too, but that let a
 * cloned repo steer a credentialed request (API key + `aai secret` values)
 * to any process listening on a local port — the exact input class this
 * trust model exists to gate. Dev mode still targets `DEFAULT_DEV_SERVER`
 * before the project config is ever consulted, and `--server` approves a
 * local origin like any other.
 */
function isImplicitlyTrusted(origin: string): boolean {
  return origin === serverOrigin(DEFAULT_SERVER);
}

/**
 * Resolve which platform server to talk to.
 *
 * Precedence: an explicit `--server` flag, then dev mode, then the project
 * config, then the shipped default.
 *
 * `configUrl` comes from `.aai/project.json` — a file in the working tree, so
 * a cloned repo controls it. Because callers pair this URL with the user's API
 * key (and, for `aai secret`, with secret values), a config-supplied origin is
 * only honored when it is implicitly trusted or previously approved by the
 * user via `--server`. Otherwise a repo could redirect a credentialed request
 * to a host of its choosing simply by shipping a `project.json`, and
 * `aai deploy` would hand over the developer's key on first run.
 *
 * @param approvedOrigins - Origins from the user-owned global config.
 */
export function resolveServerUrl(
  explicit?: string,
  configUrl?: string,
  approvedOrigins: readonly string[] = [],
): string {
  // An explicit flag is a direct statement of user intent, not repo content.
  if (explicit) return stripTrailingSlash(explicit);
  if (isDevMode()) return DEFAULT_DEV_SERVER;
  if (!configUrl) return DEFAULT_SERVER;

  const url = stripTrailingSlash(configUrl);
  const origin = serverOrigin(url);
  if (origin === null) {
    throw new Error(
      `Invalid serverUrl in .aai/project.json: ${configUrl}\n` +
        "  Expected an absolute http(s) URL.",
    );
  }
  if (isImplicitlyTrusted(origin) || approvedOrigins.includes(origin)) return url;
  throw new Error(
    `Refusing to send your API key to ${origin}.\n` +
      `  It came from .aai/project.json, which is part of this project's files, ` +
      "not from you.\n" +
      `  If you do intend to use that server, re-run with --server ${origin} to approve it.`,
  );
}

/**
 * Reject a repo-supplied slug that isn't the platform's slug shape.
 *
 * Enforced before a slug is ever interpolated into a URL path.
 * `.aai/project.json` is part of the working tree, so a cloned repo controls
 * this value, and callers pair it with the user's API key — `aai publish`
 * hands it to `syncEnvSecrets`, which PUTs the whole `.env` to
 * `${serverUrl}/${slug}/secret`. A hostile `"slug": "x/../admin"` must not
 * steer that request to a path of the repo's choosing.
 *
 * Lives here, at the single point where repo-controlled config becomes a
 * credentialed target, rather than at each call site: the check used to
 * exist only in `getServerInfo` (secret/storage/delete), so `publish` — the
 * command users actually run — had no guard at all.
 */
function assertValidConfigSlug(slug: string | undefined): void {
  if (slug === undefined || VALID_SLUG_RE.test(slug)) return;
  throw new Error(
    `Invalid slug in .aai/project.json: ${JSON.stringify(slug)}\n` +
      "  Expected lowercase letters, digits, `-`, `_` (2-64 chars). " +
      "Fix or delete the file — `aai publish` will create a fresh deployment.",
  );
}

/**
 * Everything `resolveDeployTarget` decides BEFORE a credential is involved:
 * the project config (null when never deployed, or when `cwd` is null), the
 * user's global config, and the trust-checked, approved server URL.
 */
export async function resolveApprovedServer(
  cwd: string | null,
  explicitServer?: string,
): Promise<{ config: ProjectConfig | null; globalConfig: GlobalConfig; serverUrl: string }> {
  const [config, globalConfig] = await Promise.all([
    cwd === null ? null : readProjectConfig(cwd),
    readGlobalConfig(),
  ]);
  const serverUrl = resolveServerUrl(
    explicitServer,
    config?.serverUrl,
    globalConfig.approvedServers ?? [],
  );
  // Passing --server is the user approving that origin; remember it so later
  // commands in this project don't need the flag again.
  if (explicitServer) await approveServer(serverUrl);
  // Before the key is resolved, and before any caller can interpolate it.
  assertValidConfigSlug(config?.slug);
  return { config, globalConfig, serverUrl };
}

/**
 * Resolve everything needed to talk to the platform: project config (null if
 * the project has never been deployed), server URL, and API key.
 *
 * `resolveApprovedServer` plus the key, rather than one function, because
 * `aai login` needs the first half and cannot have the second — it is the
 * command that PUTS the key on disk. It had its own copy of the
 * read → `resolveServerUrl` → `approveServer` sequence, which is security
 * policy ("passing `--server` is what approves an origin"), so a change to that
 * policy landed here and silently missed the one command whose whole job is to
 * write a credential for the origin in question. Same shape as the slug-guard
 * incident `assertValidConfigSlug` was moved down here for.
 *
 * The key comes from the config document already in hand — `ensureApiKey` would
 * read and parse the same file a second time, on every platform command.
 */
export async function resolveDeployTarget(cwd: string, explicitServer?: string) {
  const { config, serverUrl } = await resolveApprovedServer(cwd, explicitServer);
  return { config, serverUrl, apiKey: await ensureApiKey() };
}

/**
 * The deployed slug a slug-scoped command needs, or the sentence naming
 * `aai publish`.
 *
 * A pulled-but-never-published project has a config without a slug — for
 * slug-scoped commands (secret, storage, delete) that is the same as never
 * deployed. Exported so a command that has ALREADY resolved the target
 * (`aai delete`) can demand the slug without resolving it a second time; one
 * sentence, one place.
 *
 * The slug's SHAPE was already enforced by `resolveDeployTarget`, for every
 * command rather than only the slug-scoped ones — see `assertValidConfigSlug`.
 * Deliberately not re-checked here: two copies of that guard is what let
 * `publish` ship without one.
 */
export function requireDeployedSlug(config: { slug?: string | undefined } | null): string {
  if (!config?.slug) {
    throw new Error("This project has no deployed agent — run `aai publish` first");
  }
  return config.slug;
}

/** Like resolveDeployTarget, but requires an existing deployment (project config). */
export async function getServerInfo(cwd: string, explicitServer?: string) {
  const { config, serverUrl, apiKey } = await resolveDeployTarget(cwd, explicitServer);
  return {
    serverUrl,
    slug: requireDeployedSlug(config),
    apiKey,
    // Set when this directory is linked to a studio project. Secrets route
    // by it — see `secretRequest`.
    studioProject: config?.studioProject,
  };
}
