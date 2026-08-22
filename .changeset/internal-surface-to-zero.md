---
"@alexkroman1/aai-runtime": major
"@alexkroman1/aai-ui": major
"aai-server": patch
"aai-guest": patch
"aai-studio-server": patch
"aai-evals": patch
---

**BREAKING — the last 76 `@internal` names come off the two packages' public
barrels: 68 to `@alexkroman1/aai-runtime/internal`, 8 to a new
`@alexkroman1/aai-ui/internal`.** Both `contracts/internal-surface.json`
ratchets are now at zero, which is where `@alexkroman1/aai` already stood.

The exemption those files record is the one hole in the capability contracts: a
name tagged `@internal` at its declaration site but reachable anyway from a
public subpath belongs to no capability, gets no epoch and no frozen compiling
template, and is held to nothing but a comment. It is a ratchet that may shrink
and may never grow, and counting it is what got it paid off — `aai` went 71 to
0, `aai-runtime` 68 to 0, `aai-ui` 8 to 0.

A release tag cannot close it from the barrel. API Extractor reads `@internal`
at the DECLARATION site, so the tag on a re-export clause member is silently
ignored and the name stays `@public` in the report. A deny-listed subpath is the
mechanism, and it is the third time this repo has reached for it.

**`@alexkroman1/aai-runtime`** — the second tranche off that root barrel, after
the 31 host-internal pass-throughs that made the subpath exist. These 68 are the
package's OWN host infrastructure: the host-mode server and its tool relay, both
transports and the `Transport` contract they satisfy, the session core, the
session-state backends and the table names and DDL they own, the workflow
serving half (API handler, surface, world, install), the wake hint, the
queue-lock sweep, the step-slot publishers, and the two shipped `Logger` values.
What stays on the root barrel is exactly what a capability covers.

Where a type is contracted and its constructor is not, the two now split: the
`SessionCore`, `SessionStateBackend`, `SessionStateStore`, `SessionEventPage`,
`SessionEventStream`, `Logger` and `S2SConfig` TYPES — the shapes a host
implementing one has to name — stay on the root barrel; `createSessionCore`,
`createMemoryStateBackend`, `createSessionStateStore`, `createSessionEventStream`
and `consoleLogger` move. The 17-name OPENER CONTRACT deliberately did not move,
for the reason it did not move last time: relocating it would make a custom
speech provider import from two subpaths, one labelled not-semver-covered.

**`@alexkroman1/aai-ui`** gains its first `./internal` subpath, carrying
`SessionProvider`, `ThemeProvider`, `ToolConfigContext`, the three URL chips
(`ApiUrlChip`, `SessionUrlChips`, `UiUrlChip`), `buildAgentUrl` and
`loadClientConfig` — none of which a `client.tsx` names, and all of which sat in
a client author's autocomplete beside `client()` and `useAgentState`.

`aai-server`, `aai-guest`, `aai-cli`, `aai-evals` and `aai-studio-server` import
the moved names from the new subpaths — the cross-package consumers the seam
exists for.

Both barrels now state the rule in their module docs, so the next name does not
re-open the ratchet: a name on `/internal` that wants to become public gets its
`@internal` tag REMOVED at the declaration site and joins a capability under
`contracts/entrypoints/`, which is what buys it an epoch. It is never
re-exported from the public barrel with the tag still on it.
