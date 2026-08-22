---
"aai-studio-server": patch
"aai-server": patch
---

Stop teaching two imports that cannot resolve, and gate the docs that carried
them.

The studio's workflow preamble told its coding agent to bound a fan-out with
`mapInBatches` from `@alexkroman1/aai/utils`. That name is on
`@alexkroman1/aai/step`, so every workflow the studio generated from the
instruction opened with an unresolvable import — and `mapInBatches` is itself
the deprecated alias of `mapConcurrent`. The bullet also justified the bound by
claiming a work-stealing pool "diverges on replay", which is the opposite of
what `sdk/map-concurrent.ts` documents: a window over a shared cursor hands out
the next index monotonically, so the Nth call issued is item N-1 however the
calls settle, and that is why the batching it replaced could be dropped for a
measured 6.7x p50 tail. The bullet now names `mapConcurrent`, the right
subpath, and the rule that IS load-bearing — one step call per callback,
issued synchronously.

`@alexkroman1/aai/runtime` went away with the runtime package split, and four
files kept importing it: both example servers, the host-server bench, and the
prose in the root README. They name `@alexkroman1/aai-runtime` now, and each
example's manifest declares what it actually imports at the version the
workspace ships (they were pinned at `^5.10.0` against a 6.11.0 workspace, with
no runtime dependency at all and `ws` — which the bench needs — undeclared).

`check-doc-examples` could not have caught either. `SOURCE_GLOBS` never
included `packages/aai-runtime`, so a published package's seven `@example`
blocks were compiled by nothing, and `MARKDOWN_FILES` had one of the three
runnable examples' READMEs plus none of that package's. All three are in now
(160 examples, floor raised to 157), and `examples/host-server/README.md`'s
opening fence — the one that carried the dead import — is checked rather than
skipped as `js`.

`UPLOAD_KEY_PREFIX` was declared twice with the same value, once in
`aai-server/upload-bytes.ts` and once on `@alexkroman1/aai-runtime`'s root.
The platform imports the runtime's now. The key SHAPES still differ on purpose
— `uploadKey` interposes the slug because this route writes into a bucket
shared by every tenant — but where uploads begin is one literal again.
