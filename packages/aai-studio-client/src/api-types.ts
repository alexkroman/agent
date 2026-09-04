// Copyright 2026 the AAI authors. MIT license.
/**
 * The shapes the studio's REST surface exchanges, and the guards that
 * recognise the two of them that arrive PUSHED.
 *
 * Their own module so `api.ts` is the requests: the type block had grown to a
 * third of that file, and it is the half every pane imports while nothing but
 * `api.ts` calls `fetch`.
 *
 * A response body is narrowed by the request that asked for it — `fetchJson`
 * is generic and the route is the contract. An event-stream frame has no such
 * pairing: the SDK's reader (`readEventStream`) parses the JSON and makes no
 * claim about it, so `data` reaches a dispatch as `unknown` and the three
 * sites that used to write `JSON.parse(frame.data) as T` were asserting a
 * shape nothing had checked. The guards below are that check. Dropping a
 * frame that fails one leaves the last good state on screen, which is the
 * right answer for a stream where every frame carries a WHOLE snapshot — the
 * cast's answer was to put `undefined` into `files` and blank the Code pane.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { UIMessage } from "ai";

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
  /** `owner/repo` this project last synced to, when GitHub is connected. */
  githubRepo?: string;
  githubBranch?: string;
  /** Commit the last sync created — the card links to it. */
  githubCommit?: string;
  /** Edits the last GitHub sync does not carry. False when never synced. */
  githubStale?: boolean;
};

/**
 * `GET /studio/github` — whether this platform has a GitHub App at all, and
 * whether this ACCOUNT has connected one.
 *
 * The two are separate on purpose: `configured: false` is a property of the
 * deployment (a self-hosted platform with no App registered) and the card
 * renders nothing at all for it, where `connected: false` is a thing this user
 * can fix and the card offers the button that fixes it.
 */
export type GithubStatus = {
  configured: boolean;
  connected: boolean;
  /** The GitHub login the installation belongs to, once connected. */
  account?: string;
  accountType?: "User" | "Organization";
  /** The App's install page — where a repository is added to the installation. */
  manageUrl?: string;
};

/** One repository the installation can write, as the picker shows it. */
export type GithubRepo = {
  fullName: string;
  private: boolean;
};

/** What a sync answers. `changed: false` means the branch was already current. */
export type GithubSyncResult = {
  ok: true;
  repo: string;
  branch: string;
  changed: boolean;
  commitSha: string;
  commitUrl: string;
  syncedHash: string;
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

/** `undefined`, or a value of that primitive type. Every optional field here. */
function isOptional(value: unknown, type: "boolean" | "string"): boolean {
  return value === undefined || typeof value === type;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** The declared optional fields of {@link ProjectData}, by the type they carry. */
const PROJECT_STRINGS = [
  "deployedSlug",
  "previewSlug",
  "previewVersion",
  "previewError",
  "githubRepo",
  "githubBranch",
  "githubCommit",
] as const satisfies readonly (keyof ProjectData)[];
const PROJECT_BOOLEANS = [
  "unpublished",
  "previewStale",
  "githubStale",
] as const satisfies readonly (keyof ProjectData)[];

/**
 * Is this pushed frame a {@link ProjectData}?
 *
 * Every DECLARED field is checked, so the predicate is the whole truth rather
 * than a spot check on the one field a caller happens to read today. An
 * UNDECLARED one is ignored, which is what lets the server keep sending
 * `sourceHash` (it does) without this client having to know about it.
 */
export function isProjectData(value: unknown): value is ProjectData {
  if (!(isRecord(value) && isStringRecord(value.files))) return false;
  const { kind } = value;
  if (!(kind === undefined || kind === "agent" || kind === "workflow")) return false;
  return (
    PROJECT_STRINGS.every((field) => isOptional(value[field], "string")) &&
    PROJECT_BOOLEANS.every((field) => isOptional(value[field], "boolean"))
  );
}

/**
 * Is this pushed frame the settled conversation?
 *
 * What is checked is the ENVELOPE every reader of these messages touches — the
 * `id` React keys them by, the `role` the transcript branches on, and `parts`
 * being an array it can map. The parts THEMSELVES are not: that is a
 * discriminated union of a dozen shapes the AI SDK owns and versions, and both
 * readers here already switch on `part.type` and ignore what they do not
 * recognise, so a validator would be a second, staler copy of the SDK's own
 * version-skew rule. This is where an untyped wire meets a typed reader, and
 * the line is drawn at the fields this package reads itself.
 */
export function isChatMessages(value: unknown): value is UIMessage[] {
  return Array.isArray(value) && value.every(isChatMessage);
}

function isChatMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { role } = value;
  return (
    typeof value.id === "string" &&
    (role === "system" || role === "user" || role === "assistant") &&
    Array.isArray(value.parts)
  );
}

/** Is this pushed frame the caller's project LIST? Fully checked — it is names. */
export function isProjectNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((name) => typeof name === "string");
}
