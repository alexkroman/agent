---
"@alexkroman1/aai-runtime": major
"aai-server": patch
"@alexkroman1/aai-cli": patch
"aai-guest": patch
---

**BREAKING — 31 names move off `@alexkroman1/aai-runtime`'s root barrel to
`@alexkroman1/aai-runtime/internal`.**

Every one is a re-export of `@alexkroman1/aai/host-internal`, which the SDK
itself deny-lists from its contracted surface as "not semver-covered". That
exemption is per SUBPATH, so re-publishing the names on this package's root
barrel defeated it — fifty not-semver-covered names sat on the one surface an
embedder autocompletes over, one package along, and no contract could cover them
without promising epochs on the SDK's internals.

A release tag cannot fix it from here: API Extractor reads `@internal` at the
DECLARATION site, so a `/** @internal */` on a re-export clause member is
silently ignored (verified — the name stayed `@public` in the regenerated
report). A subpath is the mechanism, and `NON_AUTHORING_SUBPATHS` now names this
one so a name arriving there joins no capability contract.

What moved: the builtins resolver, the SSRF-safe fetch pair, the four step-slot
publishers, and the upload byte constants and id grammar. `aai-server`,
`aai-cli` and `aai-guest` import them from the new subpath — the cross-package
consumers the seam exists for.

The 17-name OPENER CONTRACT deliberately did NOT move. `registerSttKind`/
`registerTtsKind` are on the root barrel, and relocating their parameter types
would make a custom speech provider — the documented use — import from two
subpaths, one labelled not-semver-covered.

Two dead mocks came out with it, both of which had stopped covering anything
while every spec kept passing: `aai-guest`'s `vi.mock("@alexkroman1/aai-runtime")`
replacing `safeFetch` (the import had moved, so the real function ran), and the
CLI dev-server factory's `publishStepEnv`.
