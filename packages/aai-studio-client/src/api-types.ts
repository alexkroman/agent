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
