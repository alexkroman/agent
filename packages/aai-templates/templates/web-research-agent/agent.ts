/**
 * Scout: a research assistant that answers by searching the open web.
 *
 * The two builtins are the whole agent — `system-prompt.md` holds the rules
 * that make it a researcher rather than a talkative model, and there is no
 * `tools/` directory. Keep it that way: a question with four sides wants
 * `topic-briefing-agent`, which puts a subagent on each of them. This template is the
 * one lookup, done properly and cited.
 *
 * **It is also the worked example for `mcpServers`** — the OTHER way an agent
 * gets tools, and the one every other template leaves undemonstrated. An MCP
 * server is a third party publishing tools over streamable HTTP, and a research
 * agent is where that earns its keep: the open web is one source, and a paid
 * archive, an internal wiki or a docs server is another one Scout cannot reach
 * with `web_search`. Its tools join Scout's own and the citation rule covers
 * them unchanged — see the `mcp_` bullet in `system-prompt.md`.
 *
 * Read {@link ARCHIVE} for the three decisions in the declaration.
 */

import { agent, type McpServerConfig, type McpServers } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";

/**
 * The server KEY, and the first segment of every tool name it contributes.
 *
 * Exported because the spec asserts what the model ends up calling: the tools
 * arrive as `mcp_archive_<remote name>` (`mcpToolName`), so a server that
 * publishes `web_search` cannot land where Scout's builtin of that name stood.
 * That namespacing is the reason a key exists at all, and 24 characters is its
 * cap — long enough to be readable, short enough that the prefixed name still
 * clears what a provider accepts.
 */
export const ARCHIVE_KEY = "archive";

/** Env var naming the archive's streamable-HTTP endpoint. Unset: no archive. */
export const ARCHIVE_URL_ENV = "SCOUT_ARCHIVE_MCP_URL";

/** Env var holding the archive's bearer token — the NAME, never the token. */
export const ARCHIVE_TOKEN_ENV = "SCOUT_ARCHIVE_MCP_TOKEN";

/**
 * The archive endpoint, read at module scope so the declaration below can be
 * absent rather than empty.
 *
 * **A starter must deploy with no credential at all**, and an `mcpServers`
 * entry pointing at a URL nobody configured is a connect attempt on every boot
 * — logged, survivable (a bad server costs its own tools and nothing else),
 * and still noise in the log of an agent whose selling point is that it runs
 * the moment it is deployed. So the whole declaration is gated: out of the box
 * Scout is exactly the two builtins, and pointing this variable at a server is
 * what turns the archive on.
 */
const archiveUrl = process.env[ARCHIVE_URL_ENV];

/**
 * The archive, when one is configured.
 *
 * Three decisions worth reading, all of them the SDK's rules applied rather
 * than invented here:
 *
 * 1. **A URL literal, a token NAME.** `url` is not a secret and is what an
 *    author looks at; the token is one, so the config records which variable
 *    holds it. There is no inline `token` field to reach for.
 * 2. **`tokenEnv` goes in `requiredEnv` too**, below, and nothing derives one
 *    from the other on purpose — `requiredEnv` is what a DEPLOY preflights, so
 *    a server declared without its token is a deploy that fails by name
 *    instead of a session that quietly has no archive tools.
 * 3. **No `pinnedTools`.** An MCP server owns its own tool descriptions and can
 *    change them after you trusted it; pinning `remote name -> fingerprint`
 *    freezes the set a human reviewed. A template cannot know a real server's
 *    fingerprints, and inventing one would pin nothing, so this trusts on first
 *    use — which is the documented default, and `withMcpTools` reports the
 *    fingerprints it discovered so a real deployment can adopt a pin by copying
 *    them in here.
 *
 * The annotation is what makes a mistyped field a compile error at the
 * declaration: assigned to an unannotated `const`, `token:` for `tokenEnv:`
 * widens quietly and only fails further down.
 */
const ARCHIVE: McpServerConfig | undefined = archiveUrl
  ? { url: archiveUrl, tokenEnv: ARCHIVE_TOKEN_ENV }
  : undefined;

/**
 * Keyed by {@link ARCHIVE_KEY}. A record rather than a list so the key is
 * stated once and cannot drift from the name the model sees.
 */
const mcpServers: McpServers | undefined = ARCHIVE ? { [ARCHIVE_KEY]: ARCHIVE } : undefined;

export default agent({
  name: "Scout",
  // The listing line — a registry row, `aai list`, the studio's picker. Never
  // the model: the researcher rules are `system-prompt.md`'s. It names the
  // citation because that is what separates Scout from a model guessing.
  description: "Answers questions by searching the open web and citing what it found",
  greeting:
    "Hey, I'm Scout. I search the web for answers. Try asking me something like, what happened in tech news today, or who won the last World Cup.",
  builtinTools: ["web_search", "visit_webpage"],
  /**
   * A ceiling on what one call may spend — the one knob this starter needs and
   * the other templates do not.
   *
   * Scout is the only agent here whose context grows with text it did not
   * write. Every `visit_webpage` result (capped at `MAX_PAGE_CHARS`, ~2,500
   * tokens) is appended to the conversation and RE-SENT on every later turn, so
   * a long call reading a dozen pages spends roughly the square of what it
   * read. Nothing else bounds that: `maxSteps` bounds one reply, not a call.
   *
   * The number is deliberately far above any real research call — a few pages
   * over a few dozen turns lands an order of magnitude under it — so it is a
   * runaway guard and not a budget a caller can feel. It is here because this
   * is a STARTER: it deploys with two builtins and no credential of its own, on
   * somebody's URL, and the shape of "left running" is exactly what this
   * catches.
   *
   * **What it costs is stated rather than hidden.** Crossing it is fatal: the
   * session ends with an `error.reported` frame and a browser client releases
   * the microphone, so the caller hears a dropped call rather than an
   * explanation. An agent that wants to say something first watches
   * `usage.updated` through `agent({ events })` and speaks before the cap
   * arrives — a fair amount of machinery for a starter, which is why this one
   * takes the blunt version and says so.
   */
  usageLimits: { totalTokens: 500_000 },
  // Spread rather than `mcpServers: undefined`: an agent with no archive
  // declares no server and asks a deploy for no credential, which is the
  // shape every field on this call already has.
  ...omitUndefined({ mcpServers, requiredEnv: mcpServers && [ARCHIVE_TOKEN_ENV] }),
});
