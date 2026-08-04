// Copyright 2025 the AAI authors. MIT license.
// Entry: sign-in gate (magic link) → AssemblyAI key onboarding → the studio
// app under a QueryClientProvider.
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
// attacker-controlled. The session is in `localStorage` (auth.tsx) so that
// signing in once lasts — a KNOWN, ACCEPTED exposure, recorded here rather
// than papered over: any tenant agent page on this origin can read it,
// including one opened from a phishing link in a fresh tab.
//
// What that gave up is narrower than it sounds, because `sessionStorage`
// was already not a boundary here: the Live pane iframes `/:slug/`
// same-origin (preview.tsx), and a same-origin iframe shares the tab's
// sessionStorage AND can script the parent, so a hostile published
// client.tsx owned the studio session wherever it was kept. The delta is
// the separately-opened tab, which used to start with empty storage.
//
// The real fix is the one every platform in this class ships, and it is NOT
// a storage tweak: serve tenant content from its own registrable domain on
// the Public Suffix List (vercel.app, vusercontent.net, netlify.app,
// workers.dev, github.io, supabase.co — all listed), so sibling apps cannot
// share cookies and cannot script the dashboard. Then the preview iframe
// stops being same-origin and this whole paragraph goes away. Serving
// tenant pages under `/:slug/` on the studio's own origin is weaker than
// any of them — not even the same-origin policy separates a path.
//
// Until that lands: the preview trusts the user's OWN published agent and
// nothing else is ever framed, and what a stolen session yields is a
// revocable session token rather than the raw AssemblyAI key this gate used
// to store (the key lives server-side against the account).

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, api, errorText } from "./api.ts";
import { App } from "./app.tsx";
import logoUrl from "./assets/assemblyai-logomark.svg";
import { useStudioAuth } from "./auth.tsx";
import { isEnterSubmit } from "./send-button.tsx";
import "./styles.css";

const queryClient = new QueryClient();

function GateCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-cream">
      <div className="flex w-[420px] flex-col gap-3.5 rounded-lg border border-line bg-panel p-10 shadow-sm">
        <div className="flex items-center gap-2.5">
          <img src={logoUrl} alt="AssemblyAI" className="h-5 w-5" />
          <span className="font-serif text-[16px]">AssemblyAI App Builder</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function SignInGate({
  mode,
  sent,
  onSignIn,
}: {
  mode: "supabase" | "dev";
  sent: boolean;
  onSignIn: (email: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const email = draft.trim();
    if (!email || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSignIn(email);
    } catch (err) {
      setError(errorText(err) ?? "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <GateCard>
        <h1 className="m-0 font-serif text-[26px] leading-[1.18] font-normal text-balance">
          Check your email
        </h1>
        <p className="m-0 text-[15px] leading-[21px] text-muted">
          We sent a sign-in link to <strong>{draft.trim()}</strong>. Open it on this device to
          continue.
        </p>
      </GateCard>
    );
  }

  return (
    <GateCard>
      <h1 className="m-0 font-serif text-[26px] leading-[1.18] font-normal text-balance">
        Build your first voice agent
      </h1>
      <p className="m-0 text-[15px] leading-[21px] text-muted">
        {mode === "dev"
          ? "Local dev mode: enter any email to sign in."
          : "Describe a voice agent and App Builder writes and tests it — you publish when it's ready. Sign in with your email to start."}
      </p>
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
  if (busy) return "Sending…";
  return mode === "dev" ? "Sign in" : "Email me a sign-in link";
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
        {email ? `Signed in as ${email}. ` : ""}App Builder runs every agent on your own AssemblyAI
        API key — get one from{" "}
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
        {busy ? "Saving…" : "Open App Builder"}
      </button>
    </GateCard>
  );
}

/** Signed in: require the stored AssemblyAI key before the app mounts. */
function AccountGate({ bearer, onSignOut }: { bearer: string; onSignOut: () => void }) {
  const client = useQueryClient();
  const account = useQuery({
    queryKey: ["account", bearer],
    queryFn: () => api.getAccount(bearer),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 3,
  });

  if (account.error instanceof ApiError && account.error.status === 401) {
    // Expired/revoked session — back to sign-in.
    onSignOut();
    return null;
  }
  if (account.isError) {
    return (
      <GateCard>
        <p className="m-0 text-[15px] text-err">
          Could not load your account: {errorText(account.error)}
        </p>
        <button
          type="button"
          className="btn h-10 self-start px-5"
          onClick={() => void account.refetch()}
        >
          Try again
        </button>
      </GateCard>
    );
  }
  if (!account.data) return <GateCard>Loading…</GateCard>;
  if (!account.data.hasKey) {
    return (
      <KeyGate
        bearer={bearer}
        email={account.data.email}
        onSaved={() => void client.invalidateQueries({ queryKey: ["account"] })}
      />
    );
  }
  return (
    <App
      bearer={bearer}
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
  if (auth.phase === "loading") return null;
  if (auth.phase === "unavailable") {
    return (
      <GateCard>
        <p className="m-0 text-[15px] text-err">{auth.message}</p>
      </GateCard>
    );
  }
  if (auth.phase === "signedOut") {
    return <SignInGate mode={auth.mode} sent={auth.sent} onSignIn={auth.signIn} />;
  }
  return <AccountGate bearer={auth.token} onSignOut={auth.signOut} />;
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
