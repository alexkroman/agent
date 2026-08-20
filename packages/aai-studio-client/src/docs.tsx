// Copyright 2026 the AAI authors. MIT license.
// The Docs pane — this project's own HTTP API, written by the project rather
// than about it.
//
// A deployed agent IS an API: a voice agent answers `client-config` and a
// carrier webhook, a workflow app answers `GET|POST|PUT|DELETE /workflows/*`,
// and both are ordinary HTTP that anything can call. That is simultaneously the
// most useful thing about the shape and the least discoverable — nothing in a
// preview iframe suggests the same work is three `curl` calls, that a run id is
// the entire handle (no session, no cookie), or that a result can be collected
// days later from another machine.
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
// Workflows pane, and for the same reasons: the platform already
// brokers `/:slug/workflows/*`, the studio shares that origin by construction
// (see "One public origin" in packages/aai-server/CLAUDE.md), so `connect-src
// 'self'` already permits it, and a studio route in front would be a second
// thing to keep in step with the listing shape. Reading it can BOOT the
// sandbox, which is why the listing is fetched once and held (`staleTime:
// Infinity`) under a key of its own, so the Workflows pane's Refresh button
// cannot discard it and re-boot the sandbox for a listing that has not moved.

import type { WorkflowSummary } from "@alexkroman1/aai";
import { createWorkflowApiClient } from "@alexkroman1/aai/workflow-api";
import { useQuery } from "@tanstack/react-query";
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
  WORKFLOW_API_TOKEN_SECRET,
  WORKFLOW_ENDPOINTS,
} from "./docs-content.ts";
import { PaneShell } from "./pane-shell.tsx";
import { PhoneCard } from "./phone-card.tsx";
import { platformOrigin } from "./platform-origin.ts";
import { queryKeys } from "./query-keys.ts";
import { Card } from "./settings-card.tsx";
import { useCopy } from "./use-copy.ts";

/** Deadline on the listing read — generous because it may be waiting out a boot. */
const LISTING_TIMEOUT_MS = 20_000;

/** A block of code with its own copy button. The pane is largely made of these. */
function Snippet({ code, label }: { code: string; label: string }) {
  const copier = useCopy();
  return (
    <div className="flex items-start gap-2">
      {/* `<pre>`, not styled spans: this exists to be selected and pasted, and
          any markup inside the block is markup a copy picks up. */}
      <pre className="m-0 min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-cream p-3 font-mono text-[11px] leading-relaxed whitespace-pre">
        {code}
      </pre>
      <button
        type="button"
        className="btn px-2 py-1 text-xs"
        onClick={() => copier.copy(code)}
        aria-label={`Copy: ${label}`}
      >
        {copier.label(code)}
      </button>
    </div>
  );
}

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
 * Its own component because `DeployedDocs` was over the cognitive-complexity
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

type DocsPaneProps = {
  bearer: string;
  /** The open project — the secrets read is keyed by it. */
  project: string;
  /** The project's published slug. Absent until the first Publish. */
  deployedSlug?: string | undefined;
  /** The auto-deployed preview's slug — what there is to read before then. */
  previewSlug?: string | undefined;
};

export function DocsPane(props: DocsPaneProps) {
  const slug = props.deployedSlug ?? props.previewSlug;
  return (
    <PaneShell
      title="API"
      subtitle="Everything this project answers over HTTP, read from the running agent."
    >
      {slug === undefined ? (
        <Card
          title="Not deployed yet"
          blurb="Publish this project, or make an edit to build a preview, and its API shows up here."
        />
      ) : (
        <DeployedDocs {...props} slug={slug} />
      )}
    </PaneShell>
  );
}

/**
 * The pane once there IS a slug to document.
 *
 * Its own component so `slug` is a required `string` — held in one component it
 * would be `string | undefined` and every use below would narrow it by casting
 * to the `enabled:` flag above, which is the sort of agreement nothing checks.
 */
function DeployedDocs({ bearer, project, deployedSlug, slug }: DocsPaneProps & { slug: string }) {
  const base = agentBase(platformOrigin(), slug);

  // Shared cache key with the Settings pane's own read: opening both panes
  // makes one request, and a secret saved there is reflected here.
  const secrets = useQuery({
    queryKey: queryKeys.secrets(project),
    queryFn: () => api.listSecrets(bearer, project),
  });
  const secretNames = secrets.data?.vars ?? [];
  const token = secretNames.includes(WORKFLOW_API_TOKEN_SECRET);

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
      <Card
        title="Base URL"
        blurb={
          deployedSlug === undefined
            ? "Your preview agent — it has its own runs and its own database, separate from production. Publish to get a stable URL."
            : "Your published agent. Every path below hangs off it."
        }
      >
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
      {page === "voice" && (
        <PhoneCard
          deployedSlug={deployedSlug}
          secretNames={secretNames}
          pendingSecrets={secrets.data?.pending ?? []}
        />
      )}

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
