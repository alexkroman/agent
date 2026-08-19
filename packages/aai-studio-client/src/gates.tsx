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
import type { SignInCredentials } from "./auth.tsx";
import type { SignInMethods } from "./auth-methods.ts";
import { linkConfirmationCode } from "./cli-link.ts";
import { GateCard } from "./gate-card.tsx";
import { isEnterSubmit } from "./send-button.tsx";

/**
 * What the card says above the controls, which depends on what there are.
 *
 * `dev` mode gets its own sentence because its "sign-in" authenticates nobody;
 * the password-only case gets one too, since "Sign in with GitHub to start"
 * would name a button that is not on the screen.
 */
function signInBlurb(mode: "supabase" | "dev", methods: SignInMethods): string {
  if (mode === "dev") return "Local dev mode: enter any email to sign in.";
  const pitch =
    "Describe a voice agent and AssemblyAI Build writes and tests it — you publish when it's ready.";
  if (methods.github) return `${pitch} Sign in with GitHub to start.`;
  if (methods.password) return `${pitch} Sign in with your email to start.`;
  return pitch;
}

/**
 * The sign-in screen, offering exactly the methods the auth backend HAS.
 *
 * `methods` is read from GoTrue rather than assumed (see `auth.tsx`), which is
 * what lets one screen serve a hosted project on GitHub OAuth and a local stack
 * on email+password without a second code path or an environment check. A
 * backend with neither is a real state and renders as such — a card explaining
 * that no method is enabled beats three dead buttons.
 */
export function SignInGate({
  mode,
  methods,
  onSignIn,
}: {
  mode: "supabase" | "dev";
  methods: SignInMethods;
  onSignIn: (creds: SignInCredentials) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signIn = useMutation({
    // The GitHub arm navigates away — the page unloads, so its pending state
    // only ever resolves on failure. The password arms settle in place.
    mutationFn: (creds: SignInCredentials) => onSignIn(creds),
  });

  /** The credentials the email form is holding, or nothing when incomplete. */
  const emailCreds = (kind: "password" | "signup"): SignInCredentials | undefined => {
    const trimmed = email.trim();
    // A password is NOT trimmed: leading and trailing spaces are legitimate
    // characters in one, and silently stripping them makes a correct password
    // fail with the same message a wrong one gets.
    if (!(trimmed && password)) return;
    return { kind, email: trimmed, password };
  };

  const submitEmail = (kind: "password" | "signup") => {
    if (signIn.isPending) return;
    const creds = emailCreds(kind);
    if (creds) signIn.mutate(creds);
  };

  const submitDev = () => {
    const trimmed = email.trim();
    if (signIn.isPending || !trimmed) return;
    signIn.mutate({ kind: "dev", email: trimmed });
  };

  const error = errorText(signIn.error);
  const noMethod = mode === "supabase" && !methods.github && !methods.password;
  return (
    <GateCard>
      <h1 className="m-0 font-serif text-[26px] leading-[1.18] font-normal text-balance">
        Build your first voice agent
      </h1>
      <p className="m-0 text-[15px] leading-[21px] text-muted">{signInBlurb(mode, methods)}</p>

      {methods.github && (
        <button
          type="button"
          className="btn btn-primary h-10 self-start px-5"
          disabled={signIn.isPending}
          onClick={() => {
            if (!signIn.isPending) signIn.mutate({ kind: "github" });
          }}
        >
          {signIn.isPending ? "Signing in…" : "Continue with GitHub"}
        </button>
      )}

      {/* Only when there are two methods to separate. */}
      {methods.github && methods.password && (
        <div className="flex items-center gap-3 text-[13px] text-muted">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
      )}

      {(methods.password || mode === "dev") && (
        <input
          className="field h-10"
          type="email"
          autoComplete="email"
          // An accessible NAME, not just a placeholder: a placeholder is not one,
          // and it disappears as soon as there is any text, so a screen-reader
          // user revisiting a filled field has nothing to hear.
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (isEnterSubmit(e)) {
              if (mode === "dev") submitDev();
              else submitEmail("password");
            }
          }}
          placeholder="you@example.com"
          spellCheck={false}
        />
      )}

      {methods.password && (
        <input
          className="field h-10"
          type="password"
          autoComplete="current-password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (isEnterSubmit(e)) submitEmail("password");
          }}
          placeholder="Password"
        />
      )}

      {error && <p className="m-0 text-[13px] text-err">{error}</p>}
      {noMethod && (
        <p className="m-0 text-[13px] text-err">
          No sign-in method is enabled on this project's auth backend. Enable a provider (GitHub, or
          email) and try again.
        </p>
      )}

      {mode === "dev" && (
        <button
          type="button"
          className="btn btn-primary h-10 self-start px-5"
          disabled={signIn.isPending}
          onClick={submitDev}
        >
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </button>
      )}

      {methods.password && (
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            className="btn btn-primary h-10 px-5"
            disabled={signIn.isPending}
            onClick={() => submitEmail("password")}
          >
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </button>
          {/* Its own action rather than a fallback inside sign-in: creating an
              account because a password was MISTYPED is a failure the user
              cannot see, and it would leave them signed in as somebody new with
              an empty project list. */}
          <button
            type="button"
            className="btn h-10 px-5"
            disabled={signIn.isPending}
            onClick={() => submitEmail("signup")}
          >
            Create account
          </button>
        </div>
      )}
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
