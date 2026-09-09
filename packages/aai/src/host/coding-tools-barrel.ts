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
 * matcher, the grep, the capped child-process runner. They are on
 * `@alexkroman1/aai/host-internal` for the platform packages that build their
 * own tools on them: this subpath's promise is the tool SET a host installs and
 * a model calls, and every name on it is one an agent author writes.
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
