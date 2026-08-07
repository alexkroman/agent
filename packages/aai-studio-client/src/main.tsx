// Copyright 2025 the AAI authors. MIT license.
// Entry: sign-in gate (GitHub OAuth) → AssemblyAI key onboarding → the
// studio app under a QueryClientProvider. Also the `aai login` approval:
// a `?cli-link=<code>` open stashes the code per-tab and strips the URL
// (cli-link.ts — it must not ride the OAuth redirect), then renders a
// link-the-CLI gate once signed in + onboarded.
//
// The browser's bearer is a SESSION token (Supabase in production, the dev
// token locally — see auth.tsx), never an AssemblyAI key. The key is the
// mandatory SECOND screen after sign-in: the studio cannot run without it
// (it is the LLM/STT/TTS credential every agent runs on), it is always the
// USER'S OWN key — the platform holds none of its own — and it is stored
// server-side against the account, so this tab never sees it again.
//
// Threat model for what lives in this tab's storage: deployed tenant agents
// are served from the SAME web origin (`/:slug/`), and that HTML/JS is
// attacker-controlled. `sessionStorage` (not `localStorage`) limits the
// blast radius: the session never persists across restarts and is
// unreadable from a separately-opened tab, so a phishing link to a
// malicious agent page cannot read a studio user's session. It does NOT
// protect against the studio's own Live pane: the preview iframes `/:slug/`
// same-origin (preview.tsx), and a same-origin iframe shares this tab's
// sessionStorage and can script the parent, so a hostile published
// client.tsx owns the studio session regardless of where it lives. The
// complete fix is serving tenant agent pages from a dedicated origin; until
// then the preview trusts the user's own published agent and nothing else
// is ever framed. (What a stolen session yields is now a revocable ~1h
// token rather than the raw AssemblyAI key this gate used to store.)

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, api, errorText, isTransientError } from "./api.ts";
import { App } from "./app.tsx";
import { useStudioAuth } from "./auth.tsx";
import { clearCliLinkCode, consumeCliLinkCode, linkConfirmationCode } from "./cli-link.ts";
import { GateCard, GateProblem, gateProblem, queryFailure } from "./gate-card.tsx";
import { queryKeys } from "./query-keys.ts";
import { isEnterSubmit } from "./send-button.tsx";
import "./styles.css";

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

function SignInGate({
  mode,
  onSignIn,
}: {
  mode: "supabase" | "dev";
  onSignIn: (email?: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const email = draft.trim();
    if (busy || (mode === "dev" && !email)) return;
    setBusy(true);
    setError(null);
    try {
      // In supabase mode this navigates to GitHub — the page unloads, so
      // `busy` only ever resets on failure.
      await onSignIn(mode === "dev" ? email : undefined);
    } catch (err) {
      setError(errorText(err) ?? "Sign-in failed");
      setBusy(false);
      return;
    }
    if (mode === "dev") setBusy(false);
  };

  return (
    <GateCard>
      <h1 className="m-0 font-serif text-[26px] leading-[1.18] font-normal text-balance">
        Build your first voice agent
      </h1>
      <p className="m-0 text-[15px] leading-[21px] text-muted">
        {mode === "dev"
          ? "Local dev mode: enter any email to sign in."
          : "Describe a voice agent and AssemblyAI Build writes and tests it — you publish when it's ready. Sign in with GitHub to start."}
      </p>
      {mode === "dev" && (
        <input
          className="field h-10"
          type="email"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (isEnterSubmit(e)) void submit();
          }}
          placeholder="you@example.com"
          spellCheck={false}
        />
      )}
      {error && <p className="m-0 text-[13px] text-err">{error}</p>}
      <button
        type="button"
        className="btn btn-primary h-10 self-start px-5"
        disabled={busy}
        onClick={() => void submit()}
      >
        {signInLabel(busy, mode)}
      </button>
    </GateCard>
  );
}

function signInLabel(busy: boolean, mode: "supabase" | "dev"): string {
  if (busy) return "Signing in…";
  return mode === "dev" ? "Sign in" : "Continue with GitHub";
}

/**
 * The mandatory onboarding step after sign-in: the studio cannot run
 * without the user's own AssemblyAI API key (it is the credential every
 * agent's LLM/STT/TTS runs on — the platform holds none). Stored
 * server-side against the account; this tab never sees it again.
 */
function KeyGate({
  bearer,
  email,
  onSaved,
}: {
  bearer: string;
  email?: string | undefined;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const key = draft.trim();
    if (!key || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.putAccountKey(bearer, key);
      onSaved();
    } catch (err) {
      setError(errorText(err) ?? "Could not save the key");
      setBusy(false);
    }
  };

  return (
    <GateCard>
      <h1 className="m-0 font-serif text-[26px] leading-[1.18] font-normal text-balance">
        Connect your AssemblyAI account
      </h1>
      <p className="m-0 text-[15px] leading-[21px] text-muted">
        {email ? `Signed in as ${email}. ` : ""}AssemblyAI Build runs every agent on your own
        AssemblyAI API key — get one from{" "}
        <a
          href="https://www.assemblyai.com/dashboard"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          your dashboard
        </a>
        . It's stored securely with your account; you only do this once.
      </p>
      <input
        className="field h-10"
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isEnterSubmit(e)) void submit();
        }}
        placeholder="AssemblyAI API key"
        spellCheck={false}
      />
      {error && <p className="m-0 text-[13px] text-err">{error}</p>}
      <button
        type="button"
        className="btn btn-primary h-10 self-start px-5"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? "Saving…" : "Open AssemblyAI Build"}
      </button>
    </GateCard>
  );
}

/**
 * Approve (or dismiss) an `aai login` handshake: the terminal that opened
 * this tab minted the code and is polling the server for the grant. Runs
 * only after sign-in AND key onboarding, so approval always has a key to
 * grant — the CLI never participates in account setup.
 */
function CliLinkGate({
  bearer,
  code,
  email,
  onDone,
}: {
  bearer: string;
  code: string;
  email?: string | undefined;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.approveCliLink(bearer, code);
      setLinked(true);
    } catch (err) {
      setError(errorText(err) ?? "Could not link the CLI");
    } finally {
      setBusy(false);
    }
  };

  if (linked) {
    return (
      <GateCard>
        <h1 className="m-0 font-serif text-[26px] leading-[1.18] font-normal text-balance">
          Terminal linked
        </h1>
        <p className="m-0 text-[15px] leading-[21px] text-muted">
          You can return to the terminal — the CLI now uses this account's API key.
        </p>
        <button
          type="button"
          className="btn btn-primary h-10 self-start px-5"
          onClick={() => onDone()}
        >
          Open AssemblyAI Build
        </button>
      </GateCard>
    );
  }

  return (
    <GateCard>
      <h1 className="m-0 font-serif text-[26px] leading-[1.18] font-normal text-balance">
        Link the AAI CLI to this account?
      </h1>
      <p className="m-0 text-[15px] leading-[21px] text-muted">
        {email ? `Signed in as ${email}. ` : ""}A terminal running <code>aai login</code> opened
        this page and will receive this account's AssemblyAI API key.
      </p>
      <p className="m-0 rounded border border-line bg-cream px-4 py-2.5 text-center font-mono text-[18px] tracking-[0.15em]">
        {linkConfirmationCode(code)}
      </p>
      <p className="m-0 text-[15px] leading-[21px] text-muted">
        That terminal shows this same code. Only continue if it matches — if you didn't just run{" "}
        <code>aai login</code> yourself, close this page.
      </p>
      {error && <p className="m-0 text-[13px] text-err">{error}</p>}
      <div className="flex gap-2.5">
        <button
          type="button"
          className="btn btn-primary h-10 px-5"
          disabled={busy}
          onClick={() => void approve()}
        >
          {busy ? "Linking…" : "Link CLI"}
        </button>
        <button type="button" className="btn h-10 px-5" disabled={busy} onClick={() => onDone()}>
          Not now
        </button>
      </div>
    </GateCard>
  );
}

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

  const failure = queryFailure(account);

  if (failure instanceof ApiError && failure.status === 401) {
    // The server rejected this bearer. Refresh rather than sign out: this
    // query refetches on window focus, and an access token that expired while
    // the tab sat in the background is REFRESHABLE — signing out here raced
    // supabase-js's own focus refresh and dropped the user out of a session
    // that was still good. `refreshAuth` signs out on its own if the refresh
    // token is dead too, so the sign-in gate is still the end state.
    void refreshAuth();
    return null;
  }
  // Nothing to show the user yet: either still loading, or loading is not
  // going to happen and the card says so (see `gateProblem`).
  if (!account.data) {
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
        {...(auth.retry && { onRetry: auth.retry })}
      />
    );
  }
  if (auth.phase === "signedOut") {
    return <SignInGate mode={auth.mode} onSignIn={auth.signIn} />;
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
createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
);
