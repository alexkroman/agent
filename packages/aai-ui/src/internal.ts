// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-ui/internal` — the plumbing `client()` and the default
 * client install for themselves, NOT part of the public client API and not
 * covered by semver. A `client.tsx` should never import from here; everything
 * an author writes a page or a custom chrome against lives on the root export
 * and the documented subpaths.
 *
 * These names used to ride on the root barrel, tagged `@internal` and nothing
 * else, which meant they were in a client author's autocomplete beside
 * `client()`, `<Form>`, `useAgentState` and `useWorkflowRun` — eight symbols an
 * author is invited to reach for and no capability contract covers. Keeping
 * them on their own subpath keeps the root importable surface the same shape as
 * the promise: what is on it is contracted.
 *
 * A release tag cannot do this from the barrel. API Extractor reads `@internal`
 * at the DECLARATION site, so a tag written on a re-export clause member is
 * silently ignored and the name stays `@public` in the report — and the
 * contract exemption in `contracts/internal-surface.json` is per SUBPATH, so a
 * tag on the root barrel buys an entry on that ratchet rather than removing
 * one. A subpath is the mechanism, the same one `@alexkroman1/aai` and
 * `@alexkroman1/aai-runtime` already use, and `NON_AUTHORING_SUBPATHS` in
 * `scripts/_api-contracts-tree.mjs` carries the matching entry so a name
 * arriving here joins no capability contract.
 *
 * The corollary is the rule for adding to this file, and it runs the other way
 * too: a name that WANTS to be public gets its `@internal` tag removed and
 * joins a capability contract — it does not stay on the barrel wearing a tag.
 * That is what happened to `fetchClientConfig`, which the SDK's own `@public`
 * prose told a workflow-app author to call while the export excluded it.
 *
 * Named re-exports rather than `export *`: the wildcard form needs a
 * `noReExportAll` suppression, and the escape-hatch ratchet only moves down.
 *
 * @module internal
 */

// Two thirds of the client-config trio. `fetchClientConfig` is the PUBLIC half
// — a workflow app's replacement for the lookup `client()` makes for itself,
// since `page()` makes none — and stays on the root. These two are the default
// client's and the session's own plumbing: `loadClientConfig`'s `null`-vs-`{}`
// distinction is a broker-decision detail, and `buildAgentUrl` is a two-line
// path join.
export { buildAgentUrl, loadClientConfig } from "./client-config.ts";
// Tool display config context — installed by `client()` from
// `ClientConfig.tools`; not something component-tier users pass themselves.
// Its VALUE type, `ToolDisplayConfig`, is public and stays on the root: a
// caller names it to write `ClientConfig.tools`, which is authoring API.
export { ToolConfigContext } from "./components/tool-config-context.ts";
// The default shell's URL chips. Rendered by `client()` in every session mode;
// a custom chrome composes its own header rather than borrowing these.
export { ApiUrlChip, SessionUrlChips, UiUrlChip } from "./components/url-chips.tsx";
// The two providers `client()` mounts around the tree. A custom tree only needs
// them when it bypasses `client()` and mounts React itself — which is the case
// this subpath exists to keep possible without advertising it.
export { SessionProvider, ThemeProvider } from "./context.ts";
// The `getUserMedia` constraints every capture path in this package shares.
// The same category as the audio budgets `types.ts` re-exports from the SDK's
// own `/internal`: a framework decision with no `client()` field to set. It was
// on the root barrel and no `client.tsx` in the tree ever named it — a custom
// chrome opening its own microphone is the case it was published for, and one
// that bypasses `client()` reaches it here along with the providers.
export { VOICE_CAPTURE_CONSTRAINTS } from "./types.ts";
// The four tuning numbers the hooks are built around: the transcript
// placeholder, the two poll intervals and the missing-read tolerance. Every one
// is referenced by NO public signature — each appeared in the report as its own
// `export const` and nothing else — and no file outside this package named one.
// They are the same category as `aai`'s `PLAYBACK_CONCEAL_FLOOR` and
// `MIC_SILENCE_PROBE_MS`, whose move to that package's `/internal` took its
// internal-surface ratchet from 74 to 0: a framework decision with no field to
// set, sitting in a `client.tsx` author's autocomplete beside `useWorkflowRun`.
//
// The hooks that own them take the interval as an OPTION, which is the
// authoring surface for the same choice and is what stays public.
export { TRANSCRIBING_PLACEHOLDER } from "./use-user-transcript.ts";
export { DEFAULT_PROGRESS_POLL_MS } from "./use-workflow-progress.ts";
export { DEFAULT_WORKFLOW_POLL_MS, MAX_MISSING_READS } from "./use-workflow-run.ts";
