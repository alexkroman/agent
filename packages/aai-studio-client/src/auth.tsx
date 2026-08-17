// Copyright 2026 the AAI authors. MIT license.
/**
 * Browser-session auth for the studio client.
 *
 * `GET /studio/auth` names the flow: `supabase` (real GoTrue sessions via
 * supabase-js), `dev` (the local-dev email box that mints a self-describing
 * token — the counterpart of aai-server's `parseDevToken`), or `none`
 * (login unconfigured on the server).
 *
 * **In `supabase` mode, WHICH sign-in methods exist is asked of GoTrue itself**
 * (`GET /auth/v1/settings` → `readSignInMethods`), never assumed and never
 * declared a second time on our server. Both halves of that matter:
 *
 * - The local Supabase stack has the EMAIL provider on with
 *   `mailer_autoconfirm`, so a password sign-up returns a session immediately —
 *   real GoTrue, real JWT, real uid, no third party, no mail, works offline.
 *   That is what makes a local dev server usable without anyone registering a
 *   GitHub OAuth app, now that a platform database refuses no-auth dev tokens.
 * - A hosted project's enabled providers are the project's business and can
 *   change without a deploy here, so a hand-kept list on our side would be a
 *   login screen offering a button GoTrue answers `provider is not enabled` to.
 *
 * A failed or unparsable read falls back to GitHub-only, which is what this
 * screen offered before it asked: an unknown answer must not remove the method
 * production actually uses.
 *
 * Either way the app's bearer is a SESSION token, never an AssemblyAI key:
 * the key is stored server-side per user (`PUT /studio/account/key`, the
 * mandatory onboarding step after sign-in) and resolved from the session on
 * every request. Every AssemblyAI key on the platform is user-provided —
 * the browser never holds one.
 *
 * Sessions persist in `localStorage`, so closing the tab does not sign the user
 * out. That is a deliberate reversal of the per-tab storage this used to use, and
 * the precondition is recorded rather than assumed: **tenant agent pages must
 * move to a dedicated origin before launch.** Until they do, `/:slug/` is served
 * from this same web origin and its HTML/JS is attacker-controlled, so a
 * published agent page can read this key.
 *
 * What the change actually costs is narrower than it looks, and the reason is in
 * main.tsx's own threat-model note: the studio's Live pane iframes `/:slug/`
 * SAME-ORIGIN, and a same-origin iframe already shares this tab's storage and can
 * script the parent — so a hostile `client.tsx` owned the session under
 * `sessionStorage` too. The delta is a malicious agent page opened in a
 * SEPARATELY-opened tab, which per-tab storage did keep out. Weighed against
 * signing every developer out on every tab close, and with the origin split
 * committed to before there are real users, that is the trade taken.
 *
 * The GitHub OAuth redirect round-trips in THIS tab (a top-level navigation), so
 * either storage carries the flow and its PKCE state; nothing about the redirect
 * needed the switch.
 *
 * `signInWithOAuth` redirects back to `window.location.href`, not the bare
 * origin, so ordinary query params survive the round trip. The one
 * deliberate exception is the `?cli-link=<code>` approval: cli-link.ts
 * stashes the code in sessionStorage and strips it from the URL at page
 * load — BEFORE sign-in can run — so the link code never enters the OAuth
 * redirect chain (Supabase's `redirect_to`, GitHub's `redirect_uri`).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuthConfig, api } from "./api.ts";
import { NO_PROVIDERS, readSignInMethods, type SignInMethods } from "./auth-methods.ts";
import { loadFailureText } from "./gate-card.tsx";

export type { SignInMethods } from "./auth-methods.ts";

const DEV_TOKEN_STORAGE = "aai-studio-dev-token";

/**
 * What a sign-in attempt supplies, which is different per method.
 *
 * A discriminated union rather than one `(email?, password?)` signature: with
 * the latter, "GitHub ignores both arguments" and "sign-up needs both" are
 * comments instead of types, and the gate has to be trusted to pass the right
 * subset. Sign-up is its own member rather than a fallback inside password
 * sign-in, because silently creating an account for a MISTYPED password is a
 * failure the user cannot see.
 */
export type SignInCredentials =
  | { kind: "github" }
  | { kind: "password"; email: string; password: string }
  | { kind: "signup"; email: string; password: string }
  | { kind: "dev"; email: string };

export type StudioAuthState =
  | { phase: "loading" }
  | {
      phase: "unavailable";
      message: string;
      /** The server's own words, when it managed to say any. */
      detail?: string;
      /**
       * Re-read the config, when the failure was ours to retry. Absent when
       * the server answered that login is not configured at all — there is
       * nothing a second read can change about that.
       */
      retry?: () => void;
    }
  | {
      phase: "signedOut";
      mode: "supabase" | "dev";
      /**
       * What the backend really offers, read from GoTrue — so the screen never
       * advertises a method that answers `provider is not enabled`. Both false
       * in `dev` mode, whose one method is not GoTrue's.
       */
      methods: SignInMethods;
      /** Kick off sign-in with whatever that method needs. */
      signIn: (creds: SignInCredentials) => Promise<void>;
    }
  | {
      phase: "signedIn";
      token: string;
      signOut: () => void;
      /**
       * Force a token refresh after the server rejected this bearer. See
       * {@link useStudioAuth} — `onAuthStateChange` alone cannot cover this,
       * because it never fires for a token that expired while unattended.
       */
      refresh: () => Promise<void>;
    };

// `localStorage`, to survive a tab close — the same decision as the Supabase
// session above, and it has to be the same one: a dev-mode developer signed out
// on every restart while a Supabase one stayed in would be a difference between
// the two modes that nothing in the product intends.
//
// Storage access throws in some contexts (Safari private mode, storage blocked
// by policy) — degrade to in-memory state instead of crashing.
function readDevToken(): string | null {
  try {
    return localStorage.getItem(DEV_TOKEN_STORAGE);
  } catch {
    return null;
  }
}

function writeDevToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(DEV_TOKEN_STORAGE);
    else localStorage.setItem(DEV_TOKEN_STORAGE, token);
  } catch {
    // Storage unavailable — the token still lives in component state.
  }
}

/** Browser counterpart of the server's `parseDevToken` (aai-server). */
function mintDevToken(email: string): string {
  const payload = JSON.stringify({ id: `dev:${email}`, email });
  const base64url = btoa(payload).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `dev.${base64url}.dev`;
}

export function useStudioAuth(): StudioAuthState {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configError, setConfigError] = useState<unknown>(null);
  const [token, setToken] = useState<string | null>(null);
  // What GoTrue says it offers. `null` while unread, which the gate renders as
  // the pre-methods wait rather than as "no way to sign in".
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const supabaseRef = useRef<SupabaseClient | null>(null);
  // One shared refresh for concurrent callers — every open event stream can
  // report the same dead token within the same tick.
  const refreshing = useRef<Promise<void> | null>(null);

  // Which config read is current. Bumped per read and on unmount, so a
  // response that lands after a retry started — or after the tab moved on —
  // cannot overwrite newer state.
  const configRead = useRef(0);

  /**
   * Read the auth config. Also the retry the unavailable gate offers: nothing
   * else in this hook runs until this lands, so a page opened while the server
   * was busy would otherwise be a dead end — and a reload is not the same
   * offer, since it asks that same busy server to serve the page again.
   */
  const loadConfig = useCallback(() => {
    const read = ++configRead.current;
    setConfigError(null);
    api.authConfig().then(
      (cfg) => {
        if (configRead.current === read) setConfig(cfg);
      },
      (err: unknown) => {
        // The raw error, not its text: the gate words itself from the error's
        // KIND (a busy server reads differently from a broken one), and a
        // string has already thrown that away.
        if (configRead.current === read) {
          setConfigError(err ?? new Error("Could not reach the server"));
        }
      },
    );
  }, []);

  useEffect(() => {
    loadConfig();
    return () => {
      configRead.current++;
    };
  }, [loadConfig]);

  // Supabase wiring, once the config resolves: restore any stored session
  // (including the one `detectSessionInUrl` extracts when the GitHub OAuth
  // redirect lands back here), then follow every auth change — sign-in, the
  // hourly token refresh, sign-out — so the app always holds a live access
  // token.
  // Which methods GoTrue has enabled, asked once per config. Its own effect
  // rather than part of the client wiring below: it is a plain public read that
  // must not be re-issued by the auth-state subscription's lifecycle, and a
  // failure here narrows the screen instead of breaking it.
  useEffect(() => {
    if (config?.mode !== "supabase") return;
    let current = true;
    void readSignInMethods(config.supabaseUrl, config.supabasePublishableKey).then((m) => {
      if (current) setMethods(m);
    });
    return () => {
      current = false;
    };
  }, [config]);

  useEffect(() => {
    if (config?.mode !== "supabase") return;
    const client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      // Survives a tab close — see the module doc, and the origin split it is
      // conditional on.
      auth: { storage: window.localStorage },
    });
    supabaseRef.current = client;
    void client.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      setToken(session?.access_token ?? null);
    });
    return () => {
      sub.subscription.unsubscribe();
      supabaseRef.current = null;
    };
  }, [config]);

  useEffect(() => {
    if (config?.mode !== "dev") return;
    setToken(readDevToken());
  }, [config]);

  const mode = config?.mode;
  const signIn = useCallback(
    async (creds: SignInCredentials) => {
      if (creds.kind === "dev") {
        const minted = mintDevToken(creds.email);
        writeDevToken(minted);
        setToken(minted);
        return;
      }
      const client = supabaseRef.current;
      if (mode !== "supabase" || !client) return;
      if (creds.kind === "github") {
        // Navigates to GitHub; the page unloads unless this errors first.
        const { error } = await client.auth.signInWithOAuth({
          provider: "github",
          options: { redirectTo: window.location.href },
        });
        if (error) throw new Error(error.message);
        return;
      }
      // Password and sign-up both settle in place and both emit an auth event on
      // success, so `onAuthStateChange` is what sets the token — the same path
      // the OAuth redirect lands on, rather than a second way in.
      const { error } =
        creds.kind === "signup"
          ? await client.auth.signUp({ email: creds.email, password: creds.password })
          : await client.auth.signInWithPassword({
              email: creds.email,
              password: creds.password,
            });
      if (error) throw new Error(error.message);
    },
    [mode],
  );

  /**
   * Mint a fresh access token, called when the server rejects the current one.
   *
   * This exists because `onAuthStateChange` cannot cover the case: supabase-js
   * runs its refresh ticker ONLY on focused tabs ("the refresh token ticker
   * runs only on focused tabs which prevents race conditions" —
   * `GoTrueClient._onVisibilityChanged`), so a studio tab left in the
   * background for an hour holds an expired token, emits no auth event, and
   * has no way back on its own. `refreshSession` works regardless of
   * visibility, since the refresh token outlives the access token.
   *
   * A refresh that fails is a real sign-out, not something to retry: the
   * stored session is dropped LOCALLY (no network round trip on a dead
   * session) so a reload cannot restore the same expired token and resume
   * the loop, and the app falls back to the sign-in gate. So the contract is
   * "the server rejected this bearer — recover it or sign out", which is why
   * dev mode (whose tokens carry no expiry, so a rejection means the token is
   * malformed and unrecoverable) discards its token rather than no-opping:
   * a caller left holding a bearer nobody will accept has no way forward.
   */
  const refresh = useCallback(async (): Promise<void> => {
    if (mode === "dev") {
      writeDevToken(null);
      setToken(null);
      return;
    }
    const client = supabaseRef.current;
    if (mode !== "supabase" || !client) return;
    refreshing.current ??= (async () => {
      try {
        const { data, error } = await client.auth.refreshSession();
        if (!error && data.session) {
          setToken(data.session.access_token);
          return;
        }
        await client.auth.signOut({ scope: "local" });
        setToken(null);
      } catch {
        setToken(null);
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, [mode]);

  const signOut = useCallback(() => {
    if (mode === "supabase") void supabaseRef.current?.auth.signOut();
    if (mode === "dev") writeDevToken(null);
    setToken(null);
  }, [mode]);

  if (configError) {
    return {
      ...loadFailureText(configError, "Could not reach the server"),
      phase: "unavailable",
      retry: loadConfig,
    };
  }
  if (!config) return { phase: "loading" };
  if (config.mode === "none") {
    return {
      phase: "unavailable",
      message:
        "Sign-in is not configured on this server (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are unset).",
    };
  }
  if (token) return { phase: "signedIn", token, signOut, refresh };
  // A `dev` server has one method and it is not GoTrue's, so nothing is read for
  // it. In `supabase` mode an unfinished read stays on the loading phase rather
  // than rendering a card with no buttons on it — the read is a same-origin-ish
  // public GET with its own deadline, so this is a frame or two, and its failure
  // path already yields GitHub-only rather than nothing.
  if (config.mode === "dev") {
    return { phase: "signedOut", mode: "dev", methods: NO_PROVIDERS, signIn };
  }
  if (!methods) return { phase: "loading" };
  return { phase: "signedOut", mode: config.mode, methods, signIn };
}
