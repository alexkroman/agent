// Copyright 2026 the AAI authors. MIT license.
// TanStack Query cache keys, in one place so declaration and invalidation
// sites can't drift on a typo'd inline array (a mismatch fails silently —
// nothing refetches).

import { queryOptions } from "@tanstack/react-query";
import { api } from "./api.ts";

export const queryKeys = {
  status: ["status"] as const,
  /** The signed-in account (email + whether a key is stored), per bearer. */
  account: (bearer: string) => ["account", bearer] as const,
  /** Prefix key: invalidates the account regardless of which bearer read it. */
  accounts: ["account"] as const,
  projects: ["projects"] as const,
  /**
   * The account's GitHub link, keyed by BEARER like `account` above and for
   * the same reason: it is a property of who is signed in, not of any project,
   * so a sign-out must not serve the next session a cached "connected".
   */
  github: (bearer: string) => ["github", bearer] as const,
  /** The installation's repositories — a separate read, and a slower one. */
  githubRepos: (bearer: string) => ["github-repos", bearer] as const,
  project: (name: string | null) => ["project", name] as const,
  chat: (name: string | null) => ["chat", name] as const,
  chatSession: (name: string | null) => ["chat-session", name] as const,
  /** Prefix key: invalidates every project's chat session at once. */
  chatSessions: ["chat-session"] as const,
  toolLabels: (url: string | undefined) => ["tool-labels", url] as const,
  secrets: (project: string) => ["secrets", project] as const,
  /**
   * Recent workflow runs, keyed by the SLUG they were read from — the deployed
   * agent's, or the preview's before a first publish. Not by project: those two
   * agents keep separate runs, so a key that could not tell them apart would
   * show production's runs against the preview after a publish.
   */
  workflowRuns: (slug: string | undefined) => ["workflow-runs", slug] as const,
  /**
   * The workflows an agent DECLARES, keyed by slug for the same reason its runs
   * are: production and preview are separate agents and can be at separate
   * versions, so one key for both would document the wrong deployment.
   *
   * Separate from `workflowRuns` rather than a slice of it: the declarations are
   * static per deploy (the Docs pane holds them forever), while the runs card
   * re-reads on demand — sharing a key would make its Refresh button discard
   * this pane's cache and re-boot the sandbox.
   */
  workflowDeclarations: (slug: string) => ["workflow-declarations", slug] as const,
  /**
   * One agent's `GET /:slug/client-config` — what it says it IS. Keyed by
   * slug, like the workflow declarations: production and preview can be at
   * different versions and so can disagree about the answer.
   */
  clientConfig: (slug: string) => ["client-config", slug] as const,
  /** Whether the platform serves `/:slug/` yet — the UI pane's readiness probe. */
  agentPageReady: (slug: string | undefined) => ["agent-page-ready", slug] as const,
};

/**
 * Reads issued from more than one component, as whole `queryOptions` — key,
 * fetch and freshness together — so two sites cannot share a key while
 * disagreeing about how stale its answer may be. A site layers its own
 * per-site switches (`enabled`) on top.
 */
export const sharedQueries = {
  /**
   * The account's GitHub link. Read once per pane open: each read is an Auth
   * round trip (`api.githubStatus`), so neither staleness nor a window focus
   * refetches it — a connect or disconnect invalidates it instead.
   */
  github: (bearer: string) =>
    queryOptions({
      queryKey: queryKeys.github(bearer),
      queryFn: () => api.githubStatus(bearer),
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
    }),
  /**
   * The project's secret NAMES. Shared by the Secrets pane and the Settings
   * pane's phone card, which reports whether each carrier's signing secret is
   * set, so a save in one shows up in the other.
   */
  secrets: (bearer: string, project: string) =>
    queryOptions({
      queryKey: queryKeys.secrets(project),
      queryFn: () => api.listSecrets(bearer, project),
    }),
};
