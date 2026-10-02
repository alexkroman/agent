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

import { createClient } from "@supabase/supabase-js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { readSignInMethods, type SignInMethods } from "./auth-methods.ts";
import {
  type AuthBackend,
  createStudioAuth,
  LOADING_VIEW,
  type SignInCredentials,
  type StudioAuthStore,
  type SupabaseAuthConfig,
} from "./auth-state.ts";
import { loadFailureText } from "./components/gate-card.tsx";

export type { SignInMethods } from "./auth-methods.ts";
export type { SignInCredentials } from "./auth-state.ts";

const DEV_TOKEN_STORAGE = "aai-studio-dev-token";

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
    // Storage unavailable — the token still lives in the machine's state.
  }
}

/** Browser counterpart of the server's `parseDevToken` (aai-server). */
function mintDevToken(email: string): string {
  const payload = JSON.stringify({ id: `dev:${email}`, email });
  const base64url = btoa(payload).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `dev.${base64url}.dev`;
}

/**
 * A sign-in that settles in place with no session event, so it hands its token
 * back to the machine. Accepted in either mode, as the old hook did; only the
 * `dev` gate ever offers it.
 */
async function signInDev(email: string): Promise<string> {
  const minted = mintDevToken(email);
  writeDevToken(minted);
  return minted;
}

/** `dev` mode: the token is the stored one, and nothing can refresh it. */
function devBackend(): AuthBackend {
  return {
    follow(report) {
      report(readDevToken());
      // Nothing to unsubscribe: a dev token changes only through this backend.
      return () => undefined;
    },
    signIn: async (creds) => (creds.kind === "dev" ? signInDev(creds.email) : undefined),
    // Dev tokens carry no expiry, so a rejection means the token is malformed
    // and unrecoverable: it is discarded rather than no-opped, since a caller
    // left holding a bearer nobody will accept has no way forward.
    refresh: async () => {
      writeDevToken(null);
      return null;
    },
    signOut: () => writeDevToken(null),
  };
}

/**
 * `supabase` mode: one supabase-js client per config.
 *
 * {@link AuthBackend.follow} restores any stored session (including the one
 * `detectSessionInUrl` extracts when the GitHub OAuth redirect lands back
 * here), then follows every auth change — sign-in, the hourly token refresh,
 * sign-out — so the app always holds a live access token.
 */
function supabaseBackend(config: SupabaseAuthConfig): AuthBackend {
  const client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
    // Survives a tab close — see the module doc, and the origin split it is
    // conditional on.
    auth: { storage: window.localStorage },
  });
  return {
    follow(report) {
      void client.auth.getSession().then(({ data }) => {
        report(data.session?.access_token ?? null);
      });
      const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
        report(session?.access_token ?? null);
      });
      return () => sub.subscription.unsubscribe();
    },
    async signIn(creds) {
      if (creds.kind === "dev") return signInDev(creds.email);
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
     * "the server rejected this bearer — recover it or sign out".
     */
    async refresh() {
      try {
        const { data, error } = await client.auth.refreshSession();
        if (!error && data.session) return data.session.access_token;
        await client.auth.signOut({ scope: "local" });
        return null;
      } catch {
        return null;
      }
    },
    signOut: () => void client.auth.signOut(),
  };
}

/** The machine's effects, against the real server, GoTrue and storage. */
function browserStudioAuth(): StudioAuthStore {
  return createStudioAuth({
    // Also the retry the unavailable gate offers: nothing else runs until this
    // lands, so a page opened while the server was busy would otherwise be a
    // dead end — and a reload is not the same offer, since it asks that same
    // busy server to serve the page again.
    readConfig: () => api.authConfig(),
    // A plain public read, asked once per config; a failure narrows the
    // screen to GitHub-only instead of breaking it.
    readMethods: (config) => readSignInMethods(config.supabaseUrl, config.supabasePublishableKey),
    connect: (config) => (config.mode === "dev" ? devBackend() : supabaseBackend(config)),
  });
}

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;
const loadingView = () => LOADING_VIEW;

/**
 * Which phase the studio's front door is in — the statechart in
 * `auth-state.ts`, bridged to React.
 *
 * `refresh` is the recovery for a REJECTED bearer (see `supabaseBackend`'s
 * `refresh`): concurrent callers — every open event stream can report the same
 * dead token within the same tick — share one refresh and one promise.
 */
export function useStudioAuth(): StudioAuthState {
  // Created in an effect (and stopped in its cleanup) so a StrictMode double
  // mount gets a fresh machine rather than a stopped one.
  const [store, setStore] = useState<StudioAuthStore | null>(null);
  useEffect(() => {
    const next = browserStudioAuth();
    setStore(next);
    return () => {
      next.stop();
      setStore(null);
    };
  }, []);

  const view = useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIPTION,
    store ? store.getView : loadingView,
  );

  if (!store) return { phase: "loading" };
  switch (view.phase) {
    case "failed":
      return {
        ...loadFailureText(view.error, "Could not reach the server"),
        phase: "unavailable",
        retry: store.retry,
      };
    case "notConfigured":
      return {
        phase: "unavailable",
        message:
          "Sign-in is not configured on this server (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are unset).",
      };
    case "signedIn":
      return {
        phase: "signedIn",
        token: view.token,
        signOut: store.signOut,
        refresh: store.refresh,
      };
    case "signedOut":
      return { phase: "signedOut", mode: view.mode, methods: view.methods, signIn: store.signIn };
    default:
      return { phase: "loading" };
  }
}
