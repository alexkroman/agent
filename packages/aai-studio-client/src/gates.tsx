// Copyright 2026 the AAI authors. MIT license.
/**
 * The three screens that stand between opening the studio and using it: sign
 * in, store an AssemblyAI key, and approve an `aai login` handshake.
 *
 * Split out of main.tsx, which is the composition root and now reads as one:
 * install the stale-build recovery, resolve the auth phase, gate on the
 * account, mount the app. Each of these used to carry its own
 * `draft`/`busy`/`error`/submit triple; two of them were over the same endpoint
 * and are now one {@link ApiKeyField}, and the other two use `useMutation`
 * like the rest of the package rather than tracking their own request state.
 */

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.ts";
import { errorText } from "./api-error.ts";
import { ApiKeyField } from "./api-key-field.tsx";
import { linkConfirmationCode } from "./cli-link.ts";
import { GateCard } from "./gate-card.tsx";
import { isEnterSubmit } from "./send-button.tsx";

function signInLabel(busy: boolean, mode: "supabase" | "dev"): string {
  if (busy) return "Signing in…";
  return mode === "dev" ? "Sign in" : "Continue with GitHub";
}

export function SignInGate({
  mode,
  onSignIn,
}: {
  mode: "supabase" | "dev";
  onSignIn: (email?: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");

  const signIn = useMutation({
    // In supabase mode this navigates to GitHub — the page unloads, so the
    // pending state only ever resolves on failure.
    mutationFn: (email: string | undefined) => onSignIn(email),
  });

  const submit = () => {
    const email = draft.trim();
    if (signIn.isPending || (mode === "dev" && !email)) return;
    signIn.mutate(mode === "dev" ? email : undefined);
  };

  const error = errorText(signIn.error);
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
            if (isEnterSubmit(e)) submit();
          }}
          placeholder="you@example.com"
          spellCheck={false}
        />
      )}
      {error && <p className="m-0 text-[13px] text-err">{error ?? "Sign-in failed"}</p>}
      <button
        type="button"
        className="btn btn-primary h-10 self-start px-5"
        disabled={signIn.isPending}
        onClick={submit}
      >
        {signInLabel(signIn.isPending, mode)}
      </button>
    </GateCard>
  );
}

/**
 * The mandatory onboarding step after sign-in: the studio cannot run
 * without the user's own AssemblyAI API key (it is the credential every
 * agent's LLM/STT/TTS runs on — the platform holds none). Stored
 * server-side against the account; this tab never sees it again.
 */
export function KeyGate({
  bearer,
  email,
  onSaved,
}: {
  bearer: string;
  email?: string | undefined;
  onSaved: () => void;
}) {
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
      <ApiKeyField
        bearer={bearer}
        submitLabel="Open AssemblyAI Build"
        placeholder="AssemblyAI API key"
        onSaved={onSaved}
      />
    </GateCard>
  );
}

/**
 * Approve (or dismiss) an `aai login` handshake: the terminal that opened
 * this tab minted the code and is polling the server for the grant. Runs
 * only after sign-in AND key onboarding, so approval always has a key to
 * grant — the CLI never participates in account setup.
 */
export function CliLinkGate({
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
  const approve = useMutation({ mutationFn: () => api.approveCliLink(bearer, code) });

  if (approve.isSuccess) {
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

  const error = errorText(approve.error);
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
          disabled={approve.isPending}
          onClick={() => approve.mutate()}
        >
          {approve.isPending ? "Linking…" : "Link CLI"}
        </button>
        <button
          type="button"
          className="btn h-10 px-5"
          disabled={approve.isPending}
          onClick={() => onDone()}
        >
          Not now
        </button>
      </div>
    </GateCard>
  );
}
