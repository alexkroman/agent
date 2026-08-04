// Copyright 2026 the AAI authors. MIT license.
/**
 * Browser-session auth for the studio client.
 *
 * `GET /studio/auth` names the flow: `supabase` (GitHub OAuth via
 * supabase-js — `signInWithOAuth` round-trips through GitHub and lands back
 * here), `dev` (the local-dev email box that mints a self-describing
 * token — the counterpart of aai-server's `parseDevToken`), or `none`
 * (login unconfigured on the server).
 *
 * Either way the app's bearer is a SESSION token, never an AssemblyAI key:
 * the key is stored server-side per user (`PUT /studio/account/key`, the
 * mandatory onboarding step after sign-in) and resolved from the session on
 * every request. Every AssemblyAI key on the platform is user-provided —
 * the browser never holds one.
 *
 * Supabase sessions persist in `sessionStorage` for the same reason the old
 * pasted key did (see the threat-model note in main.tsx): deployed tenant
 * agents are served same-origin, so `localStorage` would hand every
 * published agent page the user's refresh token. The GitHub OAuth redirect
 * round-trips in THIS tab (a top-level navigation, not a new tab), and
 * sessionStorage survives same-tab navigation — so per-tab storage covers
 * the whole flow, PKCE state included.
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
import { type AuthConfig, api, errorText } from "./api.ts";

const DEV_TOKEN_STORAGE = "aai-studio-dev-token";

export type StudioAuthState =
  | { phase: "loading" }
  | { phase: "unavailable"; message: string }
  | {
      phase: "signedOut";
      mode: "supabase" | "dev";
      /**
       * Kick off sign-in. `supabase` mode ignores the email (GitHub OAuth
       * navigates away and back); `dev` mode requires it.
       */
      signIn: (email?: string) => Promise<void>;
    }
  | { phase: "signedIn"; token: string; signOut: () => void };

// Storage access throws in some contexts (Safari private mode, storage
// blocked by policy) — degrade to in-memory state instead of crashing.
function readDevToken(): string | null {
  try {
    return sessionStorage.getItem(DEV_TOKEN_STORAGE);
  } catch {
    return null;
  }
}

function writeDevToken(token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(DEV_TOKEN_STORAGE);
    else sessionStorage.setItem(DEV_TOKEN_STORAGE, token);
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
  const [configError, setConfigError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const supabaseRef = useRef<SupabaseClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.authConfig().then(
      (cfg) => {
        if (!cancelled) setConfig(cfg);
      },
      (err: unknown) => {
        if (!cancelled) setConfigError(errorText(err) ?? "Could not reach the server");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Supabase wiring, once the config resolves: restore any stored session
  // (including the one `detectSessionInUrl` extracts when the GitHub OAuth
  // redirect lands back here), then follow every auth change — sign-in, the
  // hourly token refresh, sign-out — so the app always holds a live access
  // token.
  useEffect(() => {
    if (config?.mode !== "supabase") return;
    const client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { storage: window.sessionStorage },
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
    async (email?: string) => {
      if (mode === "dev") {
        if (!email) return;
        const minted = mintDevToken(email);
        writeDevToken(minted);
        setToken(minted);
        return;
      }
      const client = supabaseRef.current;
      if (mode !== "supabase" || !client) return;
      // Navigates to GitHub; the page unloads unless this errors first.
      const { error } = await client.auth.signInWithOAuth({
        provider: "github",
        options: { redirectTo: window.location.href },
      });
      if (error) throw new Error(error.message);
    },
    [mode],
  );

  const signOut = useCallback(() => {
    if (mode === "supabase") void supabaseRef.current?.auth.signOut();
    if (mode === "dev") writeDevToken(null);
    setToken(null);
  }, [mode]);

  if (configError) return { phase: "unavailable", message: configError };
  if (!config) return { phase: "loading" };
  if (config.mode === "none") {
    return {
      phase: "unavailable",
      message:
        "Sign-in is not configured on this server (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are unset).",
    };
  }
  if (token) return { phase: "signedIn", token, signOut };
  return { phase: "signedOut", mode: config.mode, signIn };
}
