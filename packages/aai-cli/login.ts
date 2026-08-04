// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai login` — link the CLI to an account that is ALREADY signed in to the
 * browser studio, ending with the account's AssemblyAI API key stored in
 * the global config (the same slot `ensureApiKey` reads), so every other
 * command is untouched by how the key was acquired.
 *
 * The CLI deliberately performs no sign-in of its own — it cannot create an
 * account, and it never sees a session token. Device-link flow:
 * 1. `GET /studio/auth` — fail fast when the server has no browser login
 *    configured (nobody could ever approve the link).
 * 2. Mint an unguessable one-shot code (32 random bytes, base64url) and
 *    open the browser at `<server>/?cli-link=<code>`. The studio — where
 *    the user signs in with GitHub (or the local-dev login) if they aren't
 *    already — shows a "link the CLI to this account?" approval displaying
 *    the same short confirmation code this terminal printed, so a phished
 *    approval link has a visible mismatch (no terminal to match against).
 * 3. Poll `POST /studio/cli-link/exchange` with the code. Approval grants
 *    the code ONE exchange for the account's stored API key, which is
 *    saved locally. An account with no stored key can't approve — the
 *    studio's own onboarding gate runs first — so the CLI never sets keys.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveServerUrl } from "./_agent.ts";
import { approveServer, getConfigDir, readGlobalConfig, writeGlobalConfig } from "./_config.ts";
import { CliError, type CommandResult, ok } from "./_output.ts";
import { log } from "./_ui.ts";

export type LoginDeps = {
  /** Test seam — never set outside tests. */
  fetchFn?: typeof globalThis.fetch;
  /** Test seam — never set outside tests. */
  openBrowser?: (url: string) => void;
  /** Test seam — never set outside tests. */
  pollIntervalMs?: number;
  /** Test seam — never set outside tests. */
  timeoutMs?: number;
};

const LINK_POLL_INTERVAL_MS = 2000;
const LINK_TIMEOUT_MS = 300_000;

async function jsonBody<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: string; msg?: string })
    | null;
  if (!res.ok) {
    const detail = body?.error ?? body?.msg ?? `HTTP ${res.status}`;
    throw new CliError("login_failed", `${what} failed: ${detail}`);
  }
  if (body === null) throw new CliError("login_failed", `${what} returned an invalid response`);
  return body;
}

function requireTty(): void {
  if (!process.stdin.isTTY) {
    throw new CliError(
      "login_interactive",
      "`aai login` is interactive and needs a TTY.",
      "Non-interactive setups can set the ASSEMBLYAI_API_KEY environment variable instead.",
    );
  }
}

function openerFor(platform: NodeJS.Platform): [string, string[]] {
  if (platform === "darwin") return ["open", []];
  if (platform === "win32") return ["cmd", ["/c", "start", ""]];
  return ["xdg-open", []];
}

/**
 * Human-matchable confirmation derived from the link code — printed in the
 * terminal AND shown on the browser approval gate (aai-studio-client's
 * cli-link.ts derives the same value; keep the two in lockstep). Not a
 * secret: both ends already hold the full code. It exists so someone who
 * lands on an approval page they didn't cause has a concrete mismatch to
 * notice ("what terminal?") instead of a bare Approve button.
 */
export function linkConfirmationCode(code: string): string {
  const head = code.slice(0, 8).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4)}`;
}

/** Best-effort: the link URL is always printed, so a failure is fine. */
function defaultOpenBrowser(url: string): void {
  const [cmd, args] = openerFor(process.platform);
  try {
    const child = spawn(cmd, [...args, url], { stdio: "ignore", detached: true });
    child.on("error", () => {
      // Swallowed: the URL is printed either way.
    });
    child.unref();
  } catch {
    // The URL is printed either way.
  }
}

export async function executeLogin(
  opts: { server?: string | undefined },
  deps: LoginDeps = {},
): Promise<CommandResult<{ email: string; server: string }>> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  requireTty();

  const globalConfig = await readGlobalConfig();
  const serverUrl = resolveServerUrl(opts.server, undefined, globalConfig.approvedServers ?? []);
  if (opts.server) await approveServer(serverUrl);

  const auth = await jsonBody<{ mode: string }>(
    await fetchFn(`${serverUrl}/studio/auth`),
    "Reading the server's login configuration",
  );
  if (auth.mode === "none") {
    throw new CliError(
      "login_unavailable",
      "This server has no browser login configured, so there is no account to link.",
      "Set the ASSEMBLYAI_API_KEY environment variable, or run any platform command to be prompted for a key.",
    );
  }

  const code = randomBytes(32).toString("base64url");
  const linkUrl = `${serverUrl}/?cli-link=${code}`;
  log.info(`Opening the browser to link your account…\n  ${linkUrl}`);
  log.info(`Confirmation code: ${linkConfirmationCode(code)}`);
  log.info(
    "Approve the link in the browser (sign in there first if you need to) — the approval page shows the same code.",
  );
  (deps.openBrowser ?? defaultOpenBrowser)(linkUrl);

  const pollInterval = deps.pollIntervalMs ?? LINK_POLL_INTERVAL_MS;
  const deadline = Date.now() + (deps.timeoutMs ?? LINK_TIMEOUT_MS);
  let granted: { apiKey: string; email?: string };
  for (;;) {
    const res = await fetchFn(`${serverUrl}/studio/cli-link/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.status !== 404) {
      granted = await jsonBody<{ apiKey: string; email?: string }>(res, "Linking your account");
      break;
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        "login_timeout",
        "Timed out waiting for the link to be approved in the browser.",
        "Run `aai login` again and approve the link within five minutes.",
      );
    }
    await sleep(pollInterval);
  }
  if (!granted.apiKey) {
    throw new CliError("login_failed", "Linking your account did not return an API key.");
  }

  const dir = getConfigDir();
  await writeGlobalConfig(dir, { ...(await readGlobalConfig(dir)), apiKey: granted.apiKey });
  const email = granted.email ?? "your account";
  log.success(`Linked ${email} — your API key is saved for future commands.`);
  return ok({ email, server: serverUrl });
}
