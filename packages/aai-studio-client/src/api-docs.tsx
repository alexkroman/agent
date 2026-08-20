// Copyright 2026 the AAI authors. MIT license.
// One agent's HTTP API, rendered from what that agent itself answers.
//
// A deployed agent IS an API: a voice agent answers `client-config` and a
// carrier webhook, a workflow app answers `GET|POST|PUT|DELETE /workflows/*`,
// and both are ordinary HTTP that anything can call. That is simultaneously the
// most useful thing about the shape and the least discoverable — nothing in a
// preview iframe suggests the same work is three `curl` calls, that a run id is
// the entire handle (no session, no cookie), or that a result can be collected
// days later from another machine.
//
// **Everything here is read from the AGENT's own PUBLIC routes**, which is what
// lets the same component serve two callers: the studio's API pane, and the
// public page at `/studio/api/<slug>` that anyone with the link can open. The
// reads are `GET /:slug/client-config` and `GET /:slug/workflows`, both of them
// already unauthenticated on a deployed agent — so the public page discloses
// nothing a `curl` at the agent did not already. What is NOT here is the half
// that would: the project's secrets and the carrier webhook live in the studio
// pane (docs.tsx), which passes them in.
//
// **Each half is offered only to the agents it is TRUE for.** A workflow app is
// not shown the carrier webhook — `page: "static"` declines `/websocket` and
// defaults telephony off, so a number pointed at one answers and hangs up — and
// an agent that declares no workflow is not shown the workflow routes, which
// the platform proxies for every agent and which need a `workflow` name it has
// none of. Both are read off the AGENT rather than the project's stored kind,
// and neither defaults while the read is outstanding: the fuller shape
// appearing and then vanishing on every open reads as a glitch.
//
// **The workflow half is GENERATED, not written.** `GET /workflows` serves each
// workflow's name, description and input schema (`WorkflowSummary`), which is
// the same JSON a page renders its form from — so the request bodies here carry
// this deployment's real field names at this version, and a workflow that gains
// a field gains it here on the next read. Documentation nobody has to remember
// to update, and nothing to drift from.
//
// **It reads the AGENT's API, not a studio route** — the same posture as the
// Workflows pane, and for the same reasons: the platform already brokers
// `/:slug/workflows/*`, the studio shares that origin by construction (see "One
// public origin" in packages/aai-server/CLAUDE.md), so `connect-src 'self'`
// already permits it, and a studio route in front would be a second thing to
// keep in step with the listing shape. Reading it can BOOT the sandbox, which
// is why the listing is fetched once and held (`staleTime: Infinity`) under a
// key of its own, so the Workflows pane's Refresh button cannot discard it and
// re-boot the sandbox for a listing that has not moved.

import type { WorkflowSummary } from "@alexkroman1/aai";
import { createWorkflowApiClient } from "@alexkroman1/aai/workflow-api";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "./api.ts";
import {
  agentBase,
  cliCommands,
  curlPoll,
  curlStart,
  type DocEndpoint,
  endpointUrl,
  frontDoorEndpoints,
  tsStart,
  WORKFLOW_ENDPOINTS,
} from "./docs-content.ts";
import { platformOrigin } from "./platform-origin.ts";
import { queryKeys } from "./query-keys.ts";
import { Card } from "./settings-card.tsx";
import { Snippet } from "./snippet.tsx";

/** Deadline on the listing read — generous because it may be waiting out a boot. */
const LISTING_TIMEOUT_MS = 20_000;

/** One route table: method, absolute URL, what it does. */
function Endpoints({ base, rows }: { base: string; rows: readonly DocEndpoint[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {rows.map((row) => (
        <li key={`${row.method} ${row.path}`} className="flex flex-col gap-0.5">
          <code className="font-mono text-xs break-all text-fg">
            <span className="text-indigo">{row.method}</span> {endpointUrl(base, row)}
          </code>
          <span className="text-[11px] text-muted">{row.summary}</span>
        </li>
      ))}
    </ul>
  );
}

/** One declared workflow: what it is, and the three ways to run it. */
function WorkflowDocs({
  base,
  workflow,
  token,
}: {
  base: string;
  workflow: WorkflowSummary;
  token: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-1">
        <code className="font-mono text-[13px] text-fg">{workflow.name}</code>
        {workflow.description !== undefined && (
          <span className="text-[11px] text-muted">{workflow.description}</span>
        )}
        {workflow.inputSchema === undefined && (
          <span className="text-[11px] text-subtle">
            Declares no input schema — it takes whatever you send.
          </span>
        )}
      </div>
      <Snippet code={curlStart(base, workflow, token)} label={`start ${workflow.name} with curl`} />
      <Snippet
        code={tsStart(base, workflow, token)}
        label={`start ${workflow.name} in TypeScript`}
      />
      <Snippet code={cliCommands(workflow).join("\n")} label={`${workflow.name} CLI commands`} />
    </div>
  );
}

/**
 * The workflow half of the pane: the route table, and one generated section per
 * workflow the agent declares.
 *
 * **Nothing here renders for an agent that declares no workflow**, which is a
 * question about DECLARATIONS rather than about routes — the platform proxies
 * `/:slug/workflows/*` for every agent, so the table would be true for a voice
 * agent and useless to it: `POST /workflows/runs` needs a `workflow` name, and
 * there is none to put there. What it gets instead is the one sentence saying
 * so, because this pane exists on the argument that the API surface is the
 * least discoverable thing about a deployment, and "you could have workflows"
 * is part of that surface where a route table for nothing is not.
 *
 * Its own component because `AgentApiDocs` was over the cognitive-complexity
 * cap with it inline — four states in one function beside two other cards.
 */
function WorkflowApi({
  base,
  token,
  declared,
  pending,
  error,
}: {
  base: string;
  token: boolean;
  /** The agent's own listing. `undefined` until it answers, and if it cannot. */
  declared: readonly WorkflowSummary[] | undefined;
  /** Still reading — the listing may be waiting out a sandbox boot. */
  pending: boolean;
  /** The agent's own sentence, when the listing could not be read. */
  error: string | undefined;
}) {
  if (declared !== undefined && declared.length > 0) {
    return (
      <>
        <Card
          title="Workflows"
          blurb={
            token
              ? "Durable runs over HTTP. This agent sets AAI_WORKFLOW_API_TOKEN, so every call needs that bearer — the snippets below carry it."
              : "Durable runs over HTTP: start one, then read it back by id from anywhere, minutes or days later. Open by default — set AAI_WORKFLOW_API_TOKEN in the Secrets pane to require a bearer."
          }
        >
          <Endpoints base={base} rows={WORKFLOW_ENDPOINTS} />
        </Card>

        <Card
          title="Running a workflow"
          blurb="Generated from this agent's own GET /workflows — the field names below are the ones it declared, at the version that is deployed right now."
        >
          <div className="flex flex-col gap-4">
            {declared.map((workflow) => (
              <WorkflowDocs key={workflow.name} base={base} workflow={workflow} token={token} />
            ))}
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <span className="text-[11px] text-muted">
                Read a run back later — the id is the whole handle.
              </span>
              <Snippet code={curlPoll(base, token)} label="read a run back" />
            </div>
          </div>
        </Card>
      </>
    );
  }
  return (
    <Card
      title="Workflows"
      blurb="Durable runs over HTTP, for work that has to outlive the request that started it."
    >
      {pending && (
        <p className="m-0 text-[13px] text-muted" role="status">
          Reading this agent's workflows…
        </p>
      )}
      {/* Quoted verbatim: a 503 while a sandbox boots and a 404 for an agent
          that serves no workflow API read very differently, and that text is
          the whole difference. */}
      {error !== undefined && (
        <p className="m-0 text-[13px] text-err">Could not read the workflows: {error}</p>
      )}
      {declared?.length === 0 && (
        <p className="m-0 text-[13px] leading-5 text-muted">
          This project declares no workflows. A voice agent does not need any — they are for work
          that has to outlive the call that started it.
        </p>
      )}
    </Card>
  );
}

export type AgentApiDocsProps = {
  /** The agent to document. Its base URL and every cache key derive from this. */
  slug: string;
  /**
   * The agent's env sets `AAI_WORKFLOW_API_TOKEN`, so every workflow call needs
   * that bearer and the snippets must carry it.
   *
   * A FACT ABOUT THE PROJECT'S SECRETS, so only the studio pane can know it —
   * the public page passes `false`, which is what an anonymous reader can
   * verify for themselves by calling the API. A closed API then answers the
   * listing read with its own 401 and the workflow card quotes that sentence,
   * which is the honest failure rather than a bearer line nobody can fill in.
   */
  token: boolean;
  /** What the Base URL card says this base IS — which agent, and how stable. */
  baseBlurb: string;
  /**
   * Rendered after the front-door card, and ONLY for a voice agent.
   *
   * The studio pane passes its carrier-webhook card here. A slot rather than a
   * flag because the card reads the project's secrets, which this component
   * neither has nor should: gating it on `page === "voice"` is the part both
   * callers share, and the part a second copy would get wrong (telephony
   * defaults OFF for `page: "static"`, so a number pointed at a workflow app
   * answers and hangs up).
   */
  voiceOnly?: ReactNode;
};

/**
 * The cards that are true of an agent whoever is reading them.
 *
 * Split out of `docs.tsx` when the same body had to serve the public page: the
 * two callers differ only in what they can additionally say (the studio knows
 * the project's secrets and its carrier webhook; the public page knows the
 * link it is at), and everything else is a function of what the agent answers.
 */
export function AgentApiDocs({ slug, token, baseBlurb, voiceOnly }: AgentApiDocsProps) {
  const base = agentBase(platformOrigin(), slug);

  // The declared workflows, from the agent itself. `staleTime: Infinity` and no
  // retry: this read can boot a sandbox, so it happens once per pane open, and
  // a failure is usually the agent's own answer (a 503 mid-boot, or the 404 an
  // agent that declares no workflows gives) rather than something to hammer.
  const workflows = useQuery({
    queryKey: queryKeys.workflowDeclarations(slug),
    queryFn: () => createWorkflowApiClient({ baseUrl: base, timeoutMs: LISTING_TIMEOUT_MS }).list(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  // What the agent says it IS, asked of the agent — the same route a browser
  // client reads before it dials. The project's stored `kind` would be the
  // cheap answer and the wrong one: it selects the coding agent's prompt and
  // is explicitly a default rather than a cage (a project can be told to
  // change shape mid-conversation), so it can disagree with what is deployed.
  // This cannot. Same one-read-per-open posture as the listing above.
  const config = useQuery({
    queryKey: queryKeys.clientConfig(slug),
    queryFn: () => api.clientConfig(base),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  // Three states, not two, and the third is why this is not `data?.page`
  // inline: until the agent answers we do not KNOW which shape it is, and a
  // default of "voice" would put the phone card on screen for a second and
  // then take it away again on every open of a workflow app's pane. A
  // FAILED read does default to voice — `page` is optional and absent has
  // always read as voice, so an agent that cannot be reached is documented
  // the way every agent built before the field is.
  const page = config.isPending ? undefined : (config.data?.page ?? "voice");
  const staticPage = page === "static";

  return (
    <>
      <Card title="Base URL" blurb={baseBlurb}>
        <Snippet code={base} label="the agent's base URL" />
      </Card>

      {/* Held back until the agent has answered, rather than defaulted: this
          card's title, blurb and rows all three differ by shape, so a default
          would render the voice version of all of them and then replace it. */}
      {page !== undefined && (
        <Card
          title={staticPage ? "The page" : "Sessions"}
          blurb={
            staticPage
              ? 'This agent serves a page rather than a voice session, and client-config says so (page: "static") — which is how a client knows not to open a socket the agent would decline. The routes below are still there and still answer.'
              : "A browser reads the config below, then opens the WebSocket it names. The URL changes when the sandbox is replaced, so clients re-read it on every connect rather than storing one — @alexkroman1/aai-ui does this for you."
          }
        >
          <Endpoints base={base} rows={frontDoorEndpoints(page)} />
        </Card>
      )}

      {/* Telephony is a VOICE surface: a workflow app declines `/websocket`
          and defaults telephony off, so a number pointed at one answers and
          hangs up. Nothing here is merely inapplicable — it is a webhook that
          would be pasted into a carrier console and then debugged. */}
      {page === "voice" && voiceOnly}

      <WorkflowApi
        base={base}
        token={token}
        declared={workflows.data}
        pending={workflows.isPending}
        error={workflows.isError ? workflows.error.message : undefined}
      />
    </>
  );
}
