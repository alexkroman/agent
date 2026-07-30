// Copyright 2025 the AAI authors. MIT license.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VALID_SLUG_RE } from "@alexkroman1/aai/utils";
import {
  approveServer,
  ensureApiKey,
  readGlobalConfig,
  readProjectConfig,
  serverOrigin,
} from "./_config.ts";

export const DEFAULT_SERVER = "https://alexkroman--aai-server-web-server.modal.run";
export const DEFAULT_DEV_SERVER = "http://localhost:8080";

let _cachedMonorepoRoot: string | null | undefined;

export function getMonorepoRoot(): string | null {
  if (_cachedMonorepoRoot !== undefined) return _cachedMonorepoRoot;
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const root1 = path.resolve(cliDir, "../..");
  const root2 = path.resolve(cliDir, "../../..");
  if (existsSync(path.join(root1, "pnpm-workspace.yaml"))) _cachedMonorepoRoot = root1;
  else if (existsSync(path.join(root2, "pnpm-workspace.yaml"))) _cachedMonorepoRoot = root2;
  else _cachedMonorepoRoot = null;
  return _cachedMonorepoRoot;
}

export function isDevMode(): boolean {
  if (process.env.AAI_NO_DEV === "1") return false;
  return getMonorepoRoot() !== null;
}

// Callers join paths with `${serverUrl}/...` — strip trailing slashes once at
// resolution time so a hand-typed `--server https://x.dev/` can't produce `//deploy`.
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
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
 * Resolve everything needed to talk to the platform: project config (null if
 * the project has never been deployed), server URL, and API key.
 */
export async function resolveDeployTarget(cwd: string, explicitServer?: string) {
  const config = await readProjectConfig(cwd);
  // Resolve (and trust-check) the target before ensureApiKey(), so an
  // untrusted serverUrl is refused without first prompting for a key.
  const globalConfig = await readGlobalConfig();
  const serverUrl = resolveServerUrl(
    explicitServer,
    config?.serverUrl,
    globalConfig.approvedServers ?? [],
  );
  // Passing --server is the user approving that origin; remember it so later
  // commands in this project don't need the flag again.
  if (explicitServer) await approveServer(serverUrl);
  const apiKey = await ensureApiKey();
  return { config, serverUrl, apiKey };
}

/** Like resolveDeployTarget, but requires an existing deployment (project config). */
export async function getServerInfo(cwd: string, explicitServer?: string) {
  const { config, serverUrl, apiKey } = await resolveDeployTarget(cwd, explicitServer);
  if (!config) {
    throw new Error("No .aai/project.json found — run `aai deploy` first");
  }
  // Enforced before a slug is ever interpolated into a URL path:
  // `.aai/project.json` is repo-controlled, so a hostile
  // `"slug": "x/../admin"` must not steer a credentialed request to an
  // arbitrary path on an approved origin.
  if (!VALID_SLUG_RE.test(config.slug)) {
    throw new Error(
      `Invalid slug in .aai/project.json: ${JSON.stringify(config.slug)}\n` +
        "  Expected lowercase letters, digits, `-`, `_` (2-64 chars). " +
        "Fix the file or run `aai deploy` to create a fresh deployment.",
    );
  }
  return { serverUrl, slug: config.slug, apiKey };
}
