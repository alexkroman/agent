// Copyright 2026 the AAI authors. MIT license.
// "API" — the endpoints for reaching this project's agent from outside the
// studio, each with a copy button.
//
// The studio shows an agent inside an iframe and a chat panel, which is the
// one place its URL is never visible. Everything else a user might do with a
// deployed agent — point a client at it, curl a workflow, hand a colleague a
// link — starts with knowing the address, and the address is not guessable:
// it needs the platform origin and the project's PUBLISHED SLUG, which is not
// the project's name.
//
// Both surfaces are listed because the studio cannot tell which one a project
// uses. The platform stores no agent config (see "The platform stores no agent
// config" in packages/aai-server/CLAUDE.md), so nothing server-side knows
// whether this agent declared `page: "static"` or a voice pipeline. Guessing
// would hide the working endpoint from half of all projects; naming both, with
// what each is for, costs two lines.

import { Card } from "./settings-card.tsx";
import { useCopy } from "./use-copy.ts";

/**
 * The long-living session endpoint — NOT the sandbox tunnel the browser
 * actually connects to.
 *
 * The tunnel URL dies with its sandbox (idle eviction, a redeploy), so handing
 * one out gives someone a link that rots. This one stays valid: a plain upgrade
 * on it resolves the live sandbox, booting it if need be, and answers a 302 to
 * wherever it currently is. The same rule `ApiUrlChip` follows in aai-ui.
 */
export function sessionUrl(origin: string, slug: string): string {
  return `${origin.replace(/^http/, "ws")}/${slug}/websocket`;
}

/** The durable-workflow HTTP API (`GET` lists, `POST /runs` starts one). */
export function workflowsUrl(origin: string, slug: string): string {
  return `${origin}/${slug}/workflows`;
}

type Endpoint = { id: string; label: string; blurb: string; url: string };

type ApiCardProps = {
  /**
   * The project's PUBLISHED slug, absent until the first Publish.
   */
  deployedSlug?: string | undefined;
  /**
   * The auto-deployed preview's slug. Shown only when nothing is published, so
   * the card has an answer from the moment a project builds — but labelled,
   * because a preview is not a stable address: it redeploys on every edit and
   * the platform reaps an orphaned one hourly.
   */
  previewSlug?: string | undefined;
};

export function ApiCard({ deployedSlug, previewSlug }: ApiCardProps) {
  const copier = useCopy();
  // The studio and the agent surface are one origin by construction (see "One
  // public origin" in packages/aai-server/CLAUDE.md), so the page's own origin
  // is the platform's — no server round trip to ask for it.
  const origin = window.location.origin;
  const slug = deployedSlug ?? previewSlug;

  if (slug === undefined) {
    return (
      <Card title="API" blurb={BLURB}>
        <p className="m-0 text-[13px] leading-5 text-muted">
          Publish this project to get its API URLs.
        </p>
      </Card>
    );
  }

  const endpoints: Endpoint[] = [
    {
      id: "session",
      label: "Voice session",
      blurb: "WebSocket. What a custom client connects to.",
      url: sessionUrl(origin, slug),
    },
    {
      id: "workflows",
      label: "Workflows",
      blurb: "HTTP. Lists this agent's durable workflows; POST /runs starts one.",
      url: workflowsUrl(origin, slug),
    },
  ];

  return (
    <Card title="API" blurb={BLURB}>
      {deployedSlug === undefined && (
        <p className="m-0 text-[11px] text-muted">
          These point at the <strong>preview</strong>, which redeploys on every edit. Publish for a
          stable address.
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {endpoints.map((endpoint) => (
          <li key={endpoint.id} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13px] font-medium text-fg">{endpoint.label}</span>
              <span className="text-[11px] text-subtle">{endpoint.blurb}</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 rounded-md border border-line bg-cream px-3 py-2 font-mono text-xs break-all">
                {endpoint.url}
              </code>
              <button
                type="button"
                className="btn px-2 py-1 text-xs"
                onClick={() => copier.copy(endpoint.url)}
                aria-label={`Copy the ${endpoint.label} URL`}
              >
                {copier.label(endpoint.url)}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const BLURB =
  "Where this agent lives, for anything outside the studio. Both surfaces are listed because " +
  "an agent serves one or the other: a voice agent answers the session endpoint, and a static " +
  "one (agent({ page: “static” })) answers the workflow API.";
