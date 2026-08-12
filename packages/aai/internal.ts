// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/internal` — infrastructure shared with the sibling
 * packages (`aai-ui`, `aai-server`, …), NOT part of the public SDK API and
 * not covered by semver. Agents and client code should never import from
 * here; everything an `agent.ts` or `client.tsx` needs lives on the root
 * export and the documented subpaths.
 *
 * These modules used to ride on the root barrel, where they drowned the
 * four-symbol authoring API (`agent`, `tool`, `assemblyAIPipeline`,
 * `assemblyAIS2s`) in autocomplete noise. Keeping them on their own subpath
 * keeps the root importable surface honest.
 *
 * Named re-exports rather than `export *`: the wildcard form needs a
 * `noReExportAll` suppression, and the escape-hatch ratchet only moves down.
 *
 * @module internal
 */

export {
  type CoalescingRunner,
  createCoalescingRunner,
} from "./sdk/coalescing-runner.ts";
// The two sentences the SDK throws when a capability is off. Off the root barrel
// because nothing an author WRITES imports them — they are read in a stack trace
// — while the guest harness and this SDK's own specs assert on the exact text.
export { STORAGE_DISABLED_MESSAGE } from "./sdk/db.ts";
export { createEpoch, type Epoch } from "./sdk/epoch.ts";
export { createOwnedMap, type OwnedMap } from "./sdk/owned-map.ts";
export { formatSchemaIssues } from "./sdk/schema.ts";
export { WORKFLOWS_UNAVAILABLE_MESSAGE } from "./sdk/workflow-limits.ts";
export { parseWsUpgradeParams } from "./sdk/ws-upgrade.ts";
