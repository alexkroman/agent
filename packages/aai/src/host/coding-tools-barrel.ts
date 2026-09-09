// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/coding-tools` — the workspace tool set for an agent that edits code.
 *
 * A FACADE. The subpath resolves here rather than at `coding-tools.ts`, which buys two
 * things the direct form could not. That module can be SPLIT as it grows without
 * moving the published entry point — the path an implementation file happens to
 * have is not a thing to promise anyone — and a name it gains next reaches the
 * public surface only when a line is added below, rather than the moment it is
 * written.
 *
 * Named re-exports rather than `export *` for the second half of that: the
 * wildcard form re-exports whatever arrives, and needs a `noReExportAll`
 * suppression the escape-hatch ratchet only lets move down.
 *
 * What is deliberately NOT here is the machinery UNDER the tools — the edit
 * matcher, the workspace grep, the capped child-process runner. This subpath's
 * promise is the tool SET a host installs and a model calls, and every name on
 * it is one an agent author writes. Of the three, only the RUNNER is published
 * at all (`@alexkroman1/aai/host-internal`, no semver promise), and only
 * because the guest harness spawns npm and the CLI bundler through it; the
 * other two have no consumer outside `coding-tools.ts` and publishing them
 * would be a surface with no reader.
 *
 * @module coding-tools
 */

export {
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MS,
  CODING_TOOL_DESCRIPTIONS,
  type CodingToolName,
  GLOB_LIMIT,
  READ_LIMIT,
} from "./coding-tool-descriptions.ts";
export { type CodingToolsOptions, createCodingTools } from "./coding-tools.ts";
