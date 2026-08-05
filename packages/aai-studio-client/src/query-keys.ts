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
  project: (name: string | null) => ["project", name] as const,
  chat: (name: string | null) => ["chat", name] as const,
  chatSession: (name: string | null) => ["chat-session", name] as const,
  /** Prefix key: invalidates every project's chat session at once. */
  chatSessions: ["chat-session"] as const,
  toolLabels: (url: string | undefined) => ["tool-labels", url] as const,
  secrets: (slug: string | undefined) => ["secrets", slug ?? "unpublished"] as const,
};
