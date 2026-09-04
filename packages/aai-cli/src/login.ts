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
import { linkConfirmationCode, sleep } from "@alexkroman1/aai/internal";
import { resolveApprovedServer } from "./_agent.ts";
import { updateGlobalConfig } from "./_config.ts";
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

/**
 * Fetch, turning a transport failure into an error that names the server.
 *
 * A connection failure here is undici's bare `TypeError: fetch failed` — no
 * URL, no cause worth printing — and `aai login` is exactly where it is least
 * diagnosable: the target is resolved (dev mode pins `localhost:8080`
 * whenever the CLI itself lives in the monorepo, whatever the cwd), so the
 * user cannot tell which server was unreachable, or that a local one was
 * expected at all. `apiRequest` has always said "could not reach <url>";
 * login used raw fetch and said nothing.
 */
async function reachable(
  fetchFn: typeof globalThis.fetch,
  url: string,
  serverUrl: string,
): Promise<Response> {
  try {
    return await fetchFn(url);
  } catch (err) {
    throw unreachableError(serverUrl, err);
  }
}

/**
 * "Could not reach <server>", with advice chosen by the kind of host and the
 * original transport failure preserved as the cause.
 */
function unreachableError(serverUrl: string, cause: unknown): CliError {
  const hint = isLoopback(serverUrl)
    ? "That's a local server — start it with `pnpm dev:aai-server`, or pass `--server <url>` " +
      "to log in elsewhere. (A CLI installed from the monorepo targets localhost by default; " +
      "set AAI_NO_DEV=1 to use the hosted platform.)"
    : "Check your network connection and verify the server URL is correct.";
  return new CliError("login_unreachable", `Could not reach ${serverUrl}.`, hint, { cause });
}

/** Whether `url`'s host is loopback — used only to pick a better hint. */
function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Poll the exchange until the browser approves the link, or the deadline.
 *
 * A transport failure is retried rather than fatal: the user is off in a
 * browser approving, and a dev server reloading in that window would
 * otherwise lose a login that was about to succeed. The last one is
 * remembered, so a server that never comes back is reported as unreachable
 * rather than as "you didn't approve in time" — which would blame the user
 * for someone else's outage.
 */
async function pollForGrant(
  fetchFn: typeof globalThis.fetch,
  serverUrl: string,
  code: string,
  opts: { intervalMs: number; deadline: number },
): Promise<{ apiKey: string; email?: string }> {
  let lastTransportError: unknown;
  for (;;) {
    let res: Response | null = null;
    try {
      res = await fetchFn(`${serverUrl}/studio/cli-link/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      lastTransportError = undefined;
    } catch (err) {
      lastTransportError = err;
    }
    // 404 is "not approved yet" — anything else settles the login.
    if (res && res.status !== 404) {
      return await jsonBody<{ apiKey: string; email?: string }>(res, "Linking your account");
    }
    if (Date.now() >= opts.deadline) {
      if (lastTransportError !== undefined) throw unreachableError(serverUrl, lastTransportError);
      throw new CliError(
        "login_timeout",
        "Timed out waiting for the link to be approved in the browser.",
        "Run `aai login` again and approve the link within five minutes.",
      );
    }
    await sleep(opts.intervalMs);
  }
}

function requireTty(): void {
  if (!process.stdin.isTTY) {
    throw new CliError(
      "login_interactive",
      "`aai login` is interactive and needs a TTY.",
      "Log in on a machine with a terminal, then point AAI_CONFIG_DIR at that config dir — logging in is the only way to authenticate.",
    );
  }
}

function openerFor(platform: NodeJS.Platform): [string, string[]] {
  if (platform === "darwin") return ["open", []];
  if (platform === "win32") return ["cmd", ["/c", "start", ""]];
  return ["xdg-open", []];
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

  // `resolveApprovedServer`, not a second copy of the trust-and-approve
  // sequence: "passing `--server` is what approves an origin" is security
  // policy, and this is the command that writes a credential FOR that origin.
  // `null` because a login is not scoped to a directory — there is no project
  // config to take a `serverUrl` from.
  const { serverUrl } = await resolveApprovedServer(null, opts.server);

  const auth = await jsonBody<{ mode: string }>(
    await reachable(fetchFn, `${serverUrl}/studio/auth`, serverUrl),
    "Reading the server's login configuration",
  );
  if (auth.mode === "none") {
    throw new CliError(
      "login_unavailable",
      "This server has no browser login configured, so there is no account to link.",
      "Point `--server` at a platform with browser login configured — linking an account there is the only way to authenticate.",
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

  const granted = await pollForGrant(fetchFn, serverUrl, code, {
    intervalMs: deps.pollIntervalMs ?? LINK_POLL_INTERVAL_MS,
    deadline: Date.now() + (deps.timeoutMs ?? LINK_TIMEOUT_MS),
  });
  if (!granted.apiKey) {
    throw new CliError("login_failed", "Linking your account did not return an API key.");
  }

  // Under the cross-process lock (see `updateGlobalConfig`): a plain
  // read-then-write here loses the key outright when another command's
  // `approveServer` straddles it, and this login has already told the user
  // their key was saved.
  await updateGlobalConfig((config) => ({ ...config, apiKey: granted.apiKey }));
  const email = granted.email ?? "your account";
  log.success(`Linked ${email} — your API key is saved for future commands.`);
  return ok({ email, server: serverUrl });
}
