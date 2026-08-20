// Copyright 2026 the AAI authors. MIT license.
/**
 * One agent's API documentation, at a URL that needs no session —
 * `/studio/api/<slug>`.
 *
 * **The studio's own API pane could not be this page.** It is behind sign-in
 * and scoped to the account that owns the project, so the one question it
 * cannot answer is the common one: "send me your API docs". A colleague, a
 * customer, or the person integrating against a deployed agent has no studio
 * account and no reason to get one, and every link the pane could hand them
 * lands on somebody else's sign-in screen.
 *
 * **It discloses nothing new.** Everything on it is read from the agent's own
 * PUBLIC routes — `GET /:slug/client-config` and `GET /:slug/workflows`, both
 * already unauthenticated on a deployed agent — so a reader could have obtained
 * all of it with two `curl` calls against a slug they already know. What the
 * page adds is that they no longer have to know to try. The account-scoped half
 * is what stays behind the studio: the project's SECRETS (and with them whether
 * the workflow API is closed by a bearer, which this page therefore reports as
 * open — see `AgentApiDocs.token`) and the carrier webhook, which is a URL to
 * configure the agent rather than one to call it.
 *
 * It is rendered BEFORE the auth gate — `main.tsx` dispatches on the path
 * rather than letting `Root` early-return — so the page never mounts
 * `useStudioAuth`, never reads `/studio/auth`, and cannot flash a sign-in
 * screen at a reader who will never have an account.
 */

import { AgentApiDocs } from "./api-docs.tsx";
import logoUrl from "./assets/assemblyai-logomark.svg";
import { PaneShell } from "./pane-shell.tsx";

export function PublicApiPage({ slug }: { slug: string }) {
  return (
    <div className="flex h-full flex-col">
      {/* The studio's bar, minus everything that needs an account: a signed-out
          reader has no project, no panes and nothing to publish. The wordmark
          links home rather than to this page's own agent — it says what built
          the thing they are reading, which is the only navigation this page
          owes anyone. */}
      <header className="flex h-[60px] flex-none items-center gap-3.5 border-b border-line bg-panel px-5">
        <a className="flex flex-none items-center gap-2.5 no-underline" href="/" title="Home">
          <img src={logoUrl} alt="AssemblyAI" className="h-5 w-5" />
          <span className="font-serif text-[16px] whitespace-nowrap text-fg">AssemblyAI Build</span>
        </a>
      </header>
      <PaneShell
        // The SLUG is the heading, and it is known without a fetch — the agent's
        // own name arrives with `client-config`, so using it would leave the
        // page titleless for as long as a sandbox takes to boot.
        title={slug}
        subtitle="Everything this agent answers over HTTP, read from the agent itself."
      >
        <AgentApiDocs
          slug={slug}
          // Unknowable from here: the bearer requirement is a fact about the
          // project's secrets. See `AgentApiDocs.token` — a closed API answers
          // the listing read with its own 401 and the workflow card quotes it.
          token={false}
          baseBlurb="Every path below hangs off this. It is a live agent — the routes answer right now."
        />
      </PaneShell>
    </div>
  );
}
