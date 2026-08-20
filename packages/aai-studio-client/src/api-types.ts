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
  /**
   * The project has opted into a database (`ctx.db`) — what the **Database
   * tab** is gated on. Off unless the user turned it on in Settings, so a
   * project that never asked for one has no pane onto an empty database.
   *
   * The server resolves the default, so this is a plain boolean there; it is
   * optional here for the same reason `unpublished` and `previewStale` are —
   * the payload may be a workspace that has not loaded yet, and absent must
   * read as "no tab" rather than as a tab that flickers away.
   */
  databaseEnabled?: boolean;
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

/**
 * Which of a project's two deployed agents an answer is about.
 *
 * Named as its own type because the Database pane's reads take it as an
 * ARGUMENT (see `api.listTables`) rather than only receiving it in a payload —
 * an inline union at each of those call sites is how one of them ends up
 * accepting a string the server 400s.
 */
export type DatabaseEnvironmentName = "production" | "preview";

export type DatabaseEnvironment = {
  environment: DatabaseEnvironmentName;
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
 * the project's setting — what the next deploy of either agent provisions —
 * while each environment row says whether it has a database RIGHT NOW.
 * `configured: false` means this server cannot provision at all.
 */
export type DatabaseState = {
  enabled: boolean;
  configured: boolean;
  environments: DatabaseEnvironment[];
  /** An environment that could not be switched, when others succeeded. */
  warning?: string;
};

/** One of an app's tables, with the exact number of rows in it. */
export type TableSummary = { schema: string; name: string; rows: number };

/** `GET …/database/tables` — the tables one environment holds. */
export type TableListing = {
  environment: DatabaseEnvironmentName;
  /** Which deployed agent answered, so the pane can name it. */
  slug: string;
  tables: TableSummary[];
};

/**
 * `GET …/database/rows` — one page of one table.
 *
 * Cells arrive as strings the server has already rendered, with `null` kept
 * distinct: the values are whatever a tenant's columns hold (Buffers, Dates,
 * int8-as-string, parsed JSON), and a browser has no type map to format that
 * lot with. `null` survives because a column may legitimately hold the empty
 * string, and the pane has to be able to show the difference.
 */
export type TablePage = {
  columns: string[];
  rows: (string | null)[][];
  /** Rows in the whole table, so the pager can say where it is. */
  total: number;
};

/** `GET /studio/status` — which LLM the studio's chat runs on. */
export type StudioStatus = {
  provider?: string;
  model?: string;
};

/** One line of a deployed agent's captured output. */
export type AgentLogLine = {
  /** Monotonic position. Pass the page's `cursor` back to read what follows. */
  seq: number;
  /** Epoch milliseconds, stamped in the guest when the line was written. */
  at: number;
  stream: "stdout" | "stderr";
  text: string;
};

/**
 * One read of an agent's log ring (`GET /:slug/logs`).
 *
 * `running` is what separates "up and quiet" from "nothing running", which an
 * empty `lines` cannot: the two call for opposite things from the reader, and a
 * pane that guesses gets the first open of every agent wrong.
 *
 * `dropped` counts lines evicted before this read reached them — the guest's
 * ring is bounded, so a tab left closed while the agent was busy comes back to
 * a gap, and a tail that hides it is indistinguishable from an agent that went
 * quiet.
 */
export type AgentLogsPage = {
  lines: AgentLogLine[];
  cursor: number;
  dropped: number;
  running: boolean;
};
