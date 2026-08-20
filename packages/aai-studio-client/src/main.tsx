// Copyright 2025 the AAI authors. MIT license.
// Entry: sign-in gate (GitHub OAuth) → AssemblyAI key onboarding → the
// studio app under a QueryClientProvider. Also the `aai login` approval:
// a `?cli-link=<code>` open stashes the code per-tab and strips the URL
// (cli-link.ts — it must not ride the OAuth redirect), then renders a
// link-the-CLI gate once signed in + onboarded. The gate screens themselves
// live in gates.tsx; this file is the composition root.
//
// The browser's bearer is a SESSION token (Supabase in production, the dev
// token locally — see auth.tsx), never an AssemblyAI key. The key is the
// mandatory SECOND screen after sign-in: the studio cannot run without it
// (it is the LLM/STT/TTS credential every agent runs on), it is always the
// USER'S OWN key — the platform holds none of its own — and it is stored
// server-side against the account, so this tab never sees it again.
//
// Threat model for what lives in this browser's storage: deployed tenant agents
// are served from the SAME web origin (`/:slug/`), and that HTML/JS is
// attacker-controlled. The session lives in `localStorage` (auth.tsx), so a
// published agent page can read it — **the fix is a dedicated origin for tenant
// agent pages, and it is owed before there are real users.**
//
// What per-tab `sessionStorage` bought here, and why it was given up: it did NOT
// protect against the studio's own Live pane, which iframes `/:slug/`
// same-origin (preview.tsx) — a same-origin iframe shares the tab's storage
// either way and can script the parent, so a hostile published client.tsx owned
// the studio session under both. The delta was a malicious agent page opened in
// a SEPARATELY-opened tab, and a session that did not survive a tab close.
// Signing every developer out on every restart is a real cost paid every day;
// the origin split closes the whole class rather than this slice of it. Until
// then the preview trusts the user's own published agent and nothing else is
// ever framed. (What a stolen session yields is a revocable ~1h access token
// plus its refresh token — never the raw AssemblyAI key this gate used to
// store, which lives server-side against the account.)

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api.ts";
import { isTransientError } from "./api-error.ts";
import { App } from "./app.tsx";
import { useStudioAuth } from "./auth.tsx";
import { authRejection, useAuthRecovery } from "./auth-recovery.ts";
import { clearCliLinkCode, consumeCliLinkCode } from "./cli-link.ts";
import { GateCard, GateProblem, gateProblem } from "./gate-card.tsx";
import { CliLinkGate, KeyGate, SignInGate } from "./gates.tsx";
import { apiDocsSlugFromPath } from "./project-route.ts";
import { PublicApiPage } from "./public-api.tsx";
import { queryKeys } from "./query-keys.ts";
import { installStaleBuildRecovery } from "./stale-build.ts";
import "./styles.css";
import { omitUndefined } from "@alexkroman1/aai/utils";

// Before anything renders: a chunk this build names can stop existing under
// a running tab (see stale-build.ts). Vite reports the modulepreload half of
// that as `vite:preloadError`, which throws if nobody claims it.
installStaleBuildRecovery();

const queryClient = new QueryClient();

/**
 * How many transient account-read failures to ride out before the retries
 * stop. Kept SHORT — a fifth of the broker query's budget (app.tsx) even
 * though the failure is the same kind — because this query gates the entire
 * app and the screen behind it is a card with a Try again button on it: a
 * long automatic budget only delays the point where pressing it does
 * anything, and the user is already being told the server is busy.
 */
const ACCOUNT_MAX_RETRIES = 2;

/** Signed in: require the stored AssemblyAI key before the app mounts. */
function AccountGate({
  bearer,
  cliLinkCode,
  onCliLinkDone,
  onSignOut,
  refreshAuth,
}: {
  bearer: string;
  cliLinkCode: string | null;
  onCliLinkDone: () => void;
  onSignOut: () => void;
  refreshAuth: () => Promise<void>;
}) {
  const client = useQueryClient();
  const account = useQuery({
    queryKey: queryKeys.account(bearer),
    queryFn: () => api.getAccount(bearer),
    retry: (count, err) => count < ACCOUNT_MAX_RETRIES && isTransientError(err),
  });

  // The server rejected this bearer. Refresh rather than sign out: this query
  // refetches on window focus, and an access token that expired while the tab
  // sat in the background is REFRESHABLE — signing out here raced supabase-js's
  // own focus refresh and dropped the user out of a session that was still
  // good. Run from an EFFECT, not the render body: `void refreshAuth(); return
  // null;` in render fired twice under StrictMode, and against a server that
  // will 401 a refreshable token (a different Supabase project, a JWT-secret
  // mismatch, clock skew) it had no terminal state at all — either an unbounded
  // refresh+refetch loop behind a blank screen, or a permanent blank once
  // gotrue's reuse interval started handing back the same token. The attempt
  // cap in `useAuthRecovery` is that terminal state, and it ends in the sign-in
  // gate rather than in nothing.
  const rejection = authRejection(account.error, account.failureReason);
  useAuthRecovery(rejection, refreshAuth, { onExhausted: onSignOut });

  if (!account.data) {
    // A rejection being worked on is a wait that SAYS something, rather than
    // the blank page a bare `return null` left behind.
    if (rejection != null) return <GateCard>Signing you back in…</GateCard>;
    // Nothing to show the user yet: either still loading, or loading is not
    // going to happen and the card says so (see `gateProblem`).
    const problem = gateProblem(account, "Could not load your account");
    return problem ? <GateProblem {...problem} /> : <GateCard>Loading…</GateCard>;
  }
  if (!account.data.hasKey) {
    return (
      <KeyGate
        bearer={bearer}
        email={account.data.email}
        onSaved={() => void client.invalidateQueries({ queryKey: queryKeys.accounts })}
      />
    );
  }
  if (cliLinkCode) {
    return (
      <CliLinkGate
        bearer={bearer}
        code={cliLinkCode}
        email={account.data.email}
        onDone={onCliLinkDone}
      />
    );
  }
  return (
    <App
      bearer={bearer}
      refreshAuth={refreshAuth}
      onSignOut={() => {
        onSignOut();
        // Query keys don't carry the bearer, so cached projects/files from
        // this account must not survive into the next one signed in.
        queryClient.clear();
      }}
    />
  );
}

function Root() {
  const auth = useStudioAuth();
  const [cliLinkCode, setCliLinkCode] = useState(consumeCliLinkCode);
  if (auth.phase === "loading") return null;
  if (auth.phase === "unavailable") {
    return (
      <GateProblem
        message={auth.message}
        detail={auth.detail}
        {...omitUndefined({ onRetry: auth.retry })}
      />
    );
  }
  if (auth.phase === "signedOut") {
    return <SignInGate mode={auth.mode} methods={auth.methods} onSignIn={auth.signIn} />;
  }
  return (
    <AccountGate
      bearer={auth.token}
      cliLinkCode={cliLinkCode}
      onCliLinkDone={() => {
        clearCliLinkCode();
        setCliLinkCode(null);
      }}
      onSignOut={auth.signOut}
      refreshAuth={auth.refresh}
    />
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Studio shell is missing its #root element");

/**
 * The public API page is chosen HERE rather than inside `Root`, and that is the
 * whole of what makes it public.
 *
 * `Root` calls `useStudioAuth` unconditionally — an early return inside it
 * would have to sit above that hook (a rule violation the moment the path can
 * change under a `pushState`) or below it, which is the version that reads
 * `/studio/auth`, restores a Supabase session, and can flash a sign-in screen
 * at a reader who has no account and needs none. Deciding before either tree
 * mounts costs one regex against a pathname the shell was served for.
 *
 * The path never changes without a navigation — the page has no router and
 * links away rather than pushing state — so one read at startup is the whole
 * lifetime of the decision.
 */
const publicApiSlug = apiDocsSlugFromPath(window.location.pathname);

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {publicApiSlug === null ? <Root /> : <PublicApiPage slug={publicApiSlug} />}
    </QueryClientProvider>
  </StrictMode>,
);
