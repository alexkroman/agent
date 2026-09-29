---
summary: >-
  The SDK's Node-only modules: guest network access and `ssrf.ts`, the bounded
  builtin fetch, `/step-files`, `/coding-tools`
read_when: >-
  editing anything under `packages/aai/src/host/`
---

# packages/aai/src/host — Node-only modules

Nothing here may be imported from `sdk/`. `/ffmpeg`, `/step-files`, `/html` and
`/coding-tools` are the four Node-only subpaths (see the subpath table in
`packages/aai/CLAUDE.md`).

## Guest network access

There is **no per-agent egress policy**; the network builtins screen a URL only
when no container surrounds them (`builtinFetch` in `ssrf.ts`, kept here so the
platform's guest-fetch proxy and the SDK builtins share ONE copy). The policy,
`AAI_SANDBOX_CONTAINED`, the screen's bypass classes and the undici-version
traps: "Guest network access" in `packages/aai-guest/CLAUDE.md`.

## A builtin's HTTP read is bounded at the READ, in BYTES

**`fetchCappedText` (`_fetch-capped.ts`) is the one bounded fetch** for every
builtin reading a model-controlled URL (`visit_webpage`, `fetch_json`,
`get_page_design`, `web_search`).

- **Bound the READ, not the kept value** — read `resp.body.getReader()` chunk by
  chunk and cancel past the budget. Never `await resp.text()` then slice, and
  never trust `content-length` (chunked responses read as `0`).
- **Budget in BYTES, never `String.length`.**

`truncated` is the caller's call (a page is readable in part, clipped JSON is
not). HTTP failure is `{ ok: false }`, not a throw.

## `/step-files` (`step-files.ts`)

ffmpeg needs a real path (a pipe cannot seek an m4a's trailing `moov`; piped
output is capped at 64 MiB). `withTempDir`, `readUploadToFile` (with no `size`
the upload must be COMPLETE), `writeUploadFromFile`, `STEP_FILE_WINDOW_BYTES`.
Its own subpath because `/step` is node-free; `step-files.import-graph.test.ts`
pins both halves.

- `writeUploadFromFile` owns the composition so the reused-read-buffer aliasing
  trap has one home: **keep the `.slice()`** (the round-trip spec fails without
  it).
- `readUploadToFile` advances by bytes actually READ, never the window size,
  so a streamed upload leaves no hole.

## `/coding-tools` (`coding-tools-barrel.ts`)

`createCodingTools({ dir })` answers nine tools keyed by model-facing name
(`read_file`, `write_file`, `edit_file`, `delete_file`, `list_files`, `glob`,
`grep`, `bash`, `todo_write`) over ONE directory, reaching nothing outside it.
Three host seams: `validate` refuses a write BEFORE it lands, `afterWrite`
appends to a successful write's result, `env` is `bash`'s child environment
(defaults to this process's — a sandbox must pass an allow-list).
`CODING_TOOL_DESCRIPTIONS` and the four limits are exported so an override
quotes the enforced number. The edit matcher, grep and capped spawn are
`/host-internal`. Worked example: `templates/coding-agent`.
