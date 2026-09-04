// Copyright 2026 the AAI authors. MIT license.
// TanStack Query cache keys, in one place so declaration and invalidation
// sites can't drift on a typo'd inline array (a mismatch fails silently —
// nothing refetches).

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
};
