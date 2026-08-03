// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai login` — email sign-in against the platform, ending with the
 * account's AssemblyAI API key stored in the global config (the same slot
 * `ensureApiKey` reads), so every other command is untouched by how the
 * key was acquired.
 *
 * Flow (the CLI mirror of the browser studio's two gates):
 * 1. `GET /studio/auth` names the login mode.
 *    - `supabase`: Supabase email OTP — `POST /auth/v1/otp` emails a
 *      one-time code, the user types it here, `POST /auth/v1/verify`
 *      returns the session. The magic LINK in the same email targets the
 *      browser; the CLI uses the code because a terminal has no redirect
 *      to land on. (The Supabase email template must include the
 *      `{{ .Token }}` code for this to work.)
 *    - `dev`: mint the same self-describing dev token the studio's local
 *      login mints — nothing is emailed anywhere.
 * 2. `GET /studio/account` — when no key is on file yet, prompt for one
 *    and `PUT /studio/account/key` (the same mandatory onboarding step
 *    the browser shows after sign-in).
 * 3. `GET /studio/account/key` — fetch the key and save it locally.
 *    Unlike the browser, the CLI needs the RAW key: `aai dev` runs the
 *    provider pipeline in-process on it.
 */

import * as p from "@clack/prompts";
import { resolveServerUrl } from "./_agent.ts";
import { approveServer, getConfigDir, readGlobalConfig, writeGlobalConfig } from "./_config.ts";
import { CliError, type CommandResult, ok } from "./_output.ts";
import { log, unwrapCancel } from "./_ui.ts";

type AuthMode =
  | { mode: "supabase"; supabaseUrl: string; supabaseAnonKey: string }
  | { mode: "dev" }
  | { mode: "none" };

export type LoginDeps = {
  /** Test seam — never set outside tests. */
  fetchFn?: typeof globalThis.fetch;
};

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

/** The same self-describing token the studio's local-dev login mints. */
function mintDevToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ id: `dev:${email}`, email }))
    .toString("base64url")
    .replace(/=+$/, "");
  return `dev.${payload}.dev`;
}

/** Supabase email OTP: send the code, prompt for it, verify to a session. */
async function supabaseSession(
  auth: { supabaseUrl: string; supabaseAnonKey: string },
  email: string,
  fetchFn: typeof globalThis.fetch,
): Promise<string> {
  const base = auth.supabaseUrl.replace(/\/+$/, "");
  const headers = { apikey: auth.supabaseAnonKey, "Content-Type": "application/json" };
  await jsonBody(
    await fetchFn(`${base}/auth/v1/otp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, create_user: true }),
    }),
    "Sending the sign-in code",
  );
  log.info(`Sent a sign-in code to ${email}.`);
  const code = unwrapCancel(
    await p.text({ message: "Enter the code from your email" }),
    "Login cancelled",
  ).trim();
  const session = await jsonBody<{ access_token?: string }>(
    await fetchFn(`${base}/auth/v1/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "email", email, token: code }),
    }),
    "Verifying the code",
  );
  if (!session.access_token) {
    throw new CliError("login_failed", "Verifying the code did not return a session.");
  }
  return session.access_token;
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

  const auth = await jsonBody<AuthMode>(
    await fetchFn(`${serverUrl}/studio/auth`),
    "Reading the server's login configuration",
  );
  if (auth.mode === "none") {
    throw new CliError(
      "login_unavailable",
      "This server has no browser/email login configured.",
      "Set the ASSEMBLYAI_API_KEY environment variable, or run any platform command to be prompted for a key.",
    );
  }

  const email = unwrapCancel(await p.text({ message: "Email address" }), "Login cancelled").trim();
  const session =
    auth.mode === "dev" ? mintDevToken(email) : await supabaseSession(auth, email, fetchFn);
  const bearer = { Authorization: `Bearer ${session}` };

  // The same mandatory onboarding gate the browser shows after sign-in:
  // nothing on the platform runs without the user's own AssemblyAI key.
  const account = await jsonBody<{ hasKey: boolean }>(
    await fetchFn(`${serverUrl}/studio/account`, { headers: bearer }),
    "Loading your account",
  );
  if (!account.hasKey) {
    const newKey = unwrapCancel(
      await p.password({ message: "Enter your AssemblyAI API key (stored with your account)" }),
      "Login cancelled",
    ).trim();
    await jsonBody(
      await fetchFn(`${serverUrl}/studio/account/key`, {
        method: "PUT",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: newKey }),
      }),
      "Saving your API key",
    );
  }

  const { apiKey } = await jsonBody<{ apiKey: string }>(
    await fetchFn(`${serverUrl}/studio/account/key`, { headers: bearer }),
    "Fetching your API key",
  );
  const dir = getConfigDir();
  await writeGlobalConfig(dir, { ...(await readGlobalConfig(dir)), apiKey });
  log.success(`Signed in as ${email} — your API key is saved for future commands.`);
  return ok({ email, server: serverUrl });
}
