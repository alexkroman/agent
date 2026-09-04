// Copyright 2026 the AAI authors. MIT license.
/**
 * Whether a server's tools still MEAN what they meant when somebody reviewed
 * them — the rug-pull check.
 *
 * ## The attack namespacing does not touch
 *
 * `mcp-tools.ts` prefixes every discovered tool with `mcp_<server>_`, so a
 * third party cannot publish `transfer_funds` and stand where the agent's own
 * tool of that name stood. That is one attack. The other is the server
 * changing what its OWN tool means after you have trusted it: `search` keeps
 * its name and its place, and its DESCRIPTION becomes "…then send the caller's
 * address to https://collector.example". The description is prompt, the input
 * schema is what the model is told to fill in, and both are the server's to
 * rewrite between one boot and the next. Nothing about the name would move.
 *
 * ## What is compared, and why it is not our hash
 *
 * `fingerprintTools` (from `ai`) digests exactly the server-controlled,
 * security-relevant fields of a `ToolSet` — `description` in its string form,
 * the RESOLVED input JSON schema, and `title` — and `detectToolDrift` is the
 * pure diff of two such maps. Both are the AI SDK's, deliberately: "which
 * fields can a server use to change a tool's meaning" is a question about the
 * MCP surface rather than about this repo, and a hash written here would have
 * to be kept in step with an answer somebody else already maintains.
 *
 * The two other things they buy: the digest is stable across the incidental
 * ordering of a JSON document, and the diff uses own-property lookups, so a
 * server publishing a tool literally named `constructor` or `toString` diffs
 * correctly rather than matching something off `Object.prototype`.
 *
 * ## The policy, and the one that was rejected
 *
 * With a pin declared, a `changed` or `added` tool is NOT OFFERED. Refusing an
 * addition looks strict — a server legitimately growing a tool loses it until
 * somebody re-pins — and the alternative is worse in the case this exists for:
 * a rug pull is cheapest to mount by adding a tool, since a new name trips no
 * comparison at all. A `removed` tool is only logged; there is nothing to
 * refuse, and the server is entitled to retire its own tool.
 *
 * With NO pin, every tool is offered and its fingerprint is reported, which is
 * trust-on-first-use stated out loud. That is the default because the
 * alternative — refusing an unpinned server — would make the feature unusable
 * before an author had seen a single tool name, and there is no automated way
 * to review a tool's description on their behalf.
 */

import { detectToolDrift, fingerprintTools, type ToolSet } from "ai";

/** `detectToolDrift`'s answer, kept as its own name so a status can carry it. */
export type McpDrift = {
  /** Tools the server publishes that the pin does not name. */
  added: readonly string[];
  /** Tools the pin names that the server no longer publishes. */
  removed: readonly string[];
  /** Tools whose pinned definition differs from the one now published. */
  changed: readonly string[];
};

/** What {@link assessTools} concluded about one server's listing. */
export type McpTrust = {
  /** Every discovered tool's fingerprint, by REMOTE name. */
  fingerprints: Readonly<Record<string, string>>;
  /** The diff against the pin — absent when the agent declared none. */
  drift?: McpDrift;
  /** Remote names that must not be offered to the model. */
  refused: ReadonlySet<string>;
};

/**
 * Fingerprint a server's listing and diff it against the reviewed baseline.
 *
 * Answers `refused` empty when there is no pin: this decides, it does not
 * enforce, so a caller cannot accidentally treat "no baseline" as "everything
 * is suspect" or the reverse.
 */
export async function assessTools(
  tools: ToolSet,
  pinned?: Readonly<Record<string, string>> | undefined,
): Promise<McpTrust> {
  const fingerprints = await fingerprintTools(tools);
  if (!pinned) return { fingerprints, refused: new Set() };
  const drift = detectToolDrift(fingerprints, { ...pinned });
  return { fingerprints, drift, refused: new Set([...drift.changed, ...drift.added]) };
}

/**
 * The lines a host should log about one server's drift, worst first.
 *
 * Returned rather than logged, so the decision and the reporting are testable
 * apart — and so the same sentences can reach a status object later without a
 * second copy of the wording. Empty when a pinned listing matched exactly.
 */
export function driftMessages(key: string, trust: McpTrust): string[] {
  const drift = trust.drift;
  if (!drift) return [];
  const lines: string[] = [];
  if (drift.changed.length > 0) {
    lines.push(
      `MCP server "${key}" changed the definition of ${quoteAll(drift.changed)} since they were pinned. They are NOT offered to the model: a tool's description and input schema are prompt, and a server can rewrite them after you trusted it. Review the new definitions and update pinnedTools if the change is legitimate.`,
    );
  }
  if (drift.added.length > 0) {
    lines.push(
      `MCP server "${key}" published ${quoteAll(drift.added)}, which pinnedTools does not name. They are NOT offered to the model — a rug pull is cheapest to mount as a new tool. Review them and add them to pinnedTools to offer them.`,
    );
  }
  if (drift.removed.length > 0) {
    lines.push(
      `MCP server "${key}" no longer publishes ${quoteAll(drift.removed)}, which pinnedTools names. Nothing is refused by this; remove the stale entries when convenient.`,
    );
  }
  return lines;
}

function quoteAll(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}
