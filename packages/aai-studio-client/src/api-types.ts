// Copyright 2026 the AAI authors. MIT license.
/**
 * The shapes the studio's REST surface exchanges.
 *
 * Their own module so `api.ts` is the requests: the type block had grown to a
 * third of that file, and it is the half every pane imports while nothing but
 * `api.ts` calls `fetch`.
 */

/**
 * What a project builds — the home hero's Agent/Workflow switcher, chosen once
 * at create time and stamped on the workspace server-side, where it selects the
 * coding agent's system prompt. The client sends it and reads it back; nothing
 * here can change it after the fact.
 */
export type ProjectKind = "agent" | "workflow";

export type ProjectData = {
  files: Record<string, string>;
  /** Voice agent or workflow app. Always present — the server resolves it. */
  kind?: ProjectKind;
  /** Production slug — updated only by Publish. */
  deployedSlug?: string;
  /** Workspace has edits the production agent does not have yet. */
  unpublished?: boolean;
  /** Preview slug — auto-deployed after agent turns and editor saves. */
  previewSlug?: string;
  /** Changes on every successful preview deploy; the iframe's reload key. */
  previewVersion?: string;
  /** Workspace has edits the preview has not deployed yet. */
  previewStale?: boolean;
  /** CLI output of the last failed preview deploy. */
  previewError?: string;
};

/**
 * The project's coding-agent sandbox, brokered by the platform. `token` is
 * the sandbox chat surface's per-session bearer — the browser presents it
 * (never a long-lived credential) on the public tunnel URL.
 */
export type ChatSession = { url: string; token: string };

/** How the login screen should sign the user in (see GET /studio/auth). */
export type AuthConfig =
  | { mode: "supabase"; supabaseUrl: string; supabasePublishableKey: string }
  | { mode: "dev" }
  | { mode: "none" };

export type Account = { email?: string; hasKey: boolean };

/** One deployed agent's database state (see GET …/database). */
/** What one environment's schema holds right now — see `appDatabaseUsage`. */
export type DatabaseUsage = {
  tables: number;
  rows: number;
  bytes: number;
};

export type DatabaseEnvironment = {
  environment: "production" | "preview";
  /** The deployed slug; absent until that environment has deployed. */
  slug?: string;
  enabled: boolean;
  /**
   * Absent when the database is off OR when the measurement failed — an
   * unread schema and an empty one are different answers, and reporting the
   * second for the first is exactly the lie this number exists to catch.
   */
  usage?: DatabaseUsage;
};

/**
 * The project's `ctx.db` database, across both deployed agents. `enabled` is
 * the project's setting — what the next deploy of either agent provisions,
 * and ON unless the project switched it off — while each environment row says
 * whether it has a database RIGHT NOW. So a new project reports
 * `enabled: true` with both rows `false`, which is not a contradiction: the
 * schema arrives with the deploy that claims the slug.
 * `configured: false` means this server cannot provision at all.
 */
export type DatabaseState = {
  enabled: boolean;
  configured: boolean;
  environments: DatabaseEnvironment[];
  /** An environment that could not be switched, when others succeeded. */
  warning?: string;
};

/** `GET /studio/status` — which LLM the studio's chat runs on. */
export type StudioStatus = {
  provider?: string;
  model?: string;
};
