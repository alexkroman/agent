// Copyright 2026 the AAI authors. MIT license.
// The API pane — this project's own HTTP API, written by the project rather
// than about it.
//
// Almost all of it is `AgentApiDocs` (api-docs.tsx), which reads the agent's
// own public routes and is shared with the public page at
// `/studio/api/<slug>`. What lives HERE is the half only the studio can say:
// the project's secrets (whether the workflow API is closed by a bearer), the
// carrier webhook, and the link to that public page.
//
// **The public link is the point of the split.** This pane is behind sign-in
// and scoped to the account that owns the project, so the one thing it could
// not do is answer "send me your API docs" — the reader would land on a
// sign-in screen for someone else's studio. The page it links to is the same
// documentation with the account-scoped half removed, at a URL that needs no
// session.

import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { AgentApiDocs } from "./api-docs.tsx";
import { WORKFLOW_API_TOKEN_SECRET } from "./docs-content.ts";
import { PaneShell } from "./pane-shell.tsx";
import { PhoneCard } from "./phone-card.tsx";
import { platformOrigin } from "./platform-origin.ts";
import { apiDocsPath } from "./project-route.ts";
import { queryKeys } from "./query-keys.ts";
import { Card } from "./settings-card.tsx";
import { Snippet } from "./snippet.tsx";

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
 * The shareable page for this agent's API — the same docs, no sign-in.
 *
 * The URL is derived rather than fetched: the studio and the agent surface are
 * one origin by construction (platform-origin.ts), and the path is the one the
 * client's own router reads, so the two cannot come to disagree about where
 * the page is. It carries an `<a>` as well as the copyable URL because the two
 * uses are different — sending the link to someone else, and checking what
 * they will see, which is worth one click rather than a paste into a private
 * window.
 */
function PublicLink({ slug, published }: { slug: string; published: boolean }) {
  const url = new URL(apiDocsPath(slug), platformOrigin()).toString();
  return (
    <Card
      title="Public API page"
      blurb={
        published
          ? "The same documentation, at a link anyone can open — no studio account, no sign-in. It reads the agent's own public routes, so it stays current with what is deployed. Your secrets and phone webhook are not on it."
          : "The same documentation, at a link anyone can open. This one points at the PREVIEW agent, which is replaced on every edit and swept when the project is deleted — publish for a link worth sending."
      }
    >
      <Snippet code={url} label="the public API page's URL" />
      <a
        className="self-start font-mono text-xs break-all text-indigo"
        href={url}
        target="_blank"
        rel="noreferrer"
      >
        Open the public page ↗
      </a>
    </Card>
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
  // Shared cache key with the Settings pane's own read: opening both panes
  // makes one request, and a secret saved there is reflected here.
  const secrets = useQuery({
    queryKey: queryKeys.secrets(project),
    queryFn: () => api.listSecrets(bearer, project),
  });
  const secretNames = secrets.data?.vars ?? [];

  return (
    <>
      <AgentApiDocs
        slug={slug}
        token={secretNames.includes(WORKFLOW_API_TOKEN_SECRET)}
        baseBlurb={
          deployedSlug === undefined
            ? "Your preview agent — it has its own runs and its own database, separate from production. Publish to get a stable URL."
            : "Your published agent. Every path below hangs off it."
        }
        voiceOnly={
          <PhoneCard
            deployedSlug={deployedSlug}
            secretNames={secretNames}
            pendingSecrets={secrets.data?.pending ?? []}
          />
        }
      />
      <PublicLink slug={slug} published={deployedSlug !== undefined} />
    </>
  );
}
