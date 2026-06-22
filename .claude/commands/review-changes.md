---
description: Review the current changes with the code-review skill plus this repo's specialized reviewers (security + module-boundary), scoped to what actually changed.
argument-hint: "[git ref to diff against, default: HEAD]"
allowed-tools: Bash(git diff*), Bash(git status*), Bash(git log*), Task, Skill
---

Review the current working changes using the general `code-review` skill and
this repo's specialized subagents. Be surgical: the code review always runs on
the diff; only dispatch a specialized reviewer if the diff actually touches its
area.

## 1. Scope the diff

Run `git status --short` and `git diff --stat ${1:-HEAD}` (and
`git diff ${1:-HEAD}` for detail) to see exactly which files changed.

## 2. Run the general code review (always)

Invoke the **`code-review`** skill on the current changes for correctness bugs
and reuse/simplification/efficiency cleanups. This runs on every
`/review-changes`, regardless of which files changed.

## 3. Dispatch the relevant specialized reviewers (in parallel)

- If the diff touches a **security boundary** — any of
  `packages/aai-server/{sandbox*,gvisor,oci-spec,sandbox-fetch,ssrf,secrets,secret-handler,middleware,deploy}.ts`
  or `packages/aai/host/{builtin-tools,_run-code,s2s}.ts` — run the
  **`security-review`** skill for the general pass, **then** dispatch the
  project's **`security-reviewer`** agent for the platform-specific guarantees
  the generic skill won't know (gVisor isolation, sdk/host sandbox safety,
  SSRF/egress proxy, run_code vm boundary, per-tenant credential separation).
- If the diff touches a **module-boundary contract** — any file under
  `packages/aai/sdk/` or `packages/aai/host/`, a `*-barrel.ts`, a
  `packages/*/package.json` `exports` block, or
  `packages/aai-templates/scaffold/package.json` — dispatch the
  **`boundary-reviewer`** agent (sdk-stays-Node-free, cross-package/internal
  import rules, subpath-export integrity, fixed-release-group + syncpack drift).
- If the diff touches none of those areas, say so and skip the specialized
  reviewers — don't manufacture a review. (The `code-review` skill from step 2
  still ran.)

Pass each agent the exact list of changed files in its scope so it reviews the
diff, not the whole repo.

## 4. Synthesize

Combine the `code-review` findings and any specialized-reviewer findings into one
ranked report (severity → file:line → fix). Call out anything that would break a
sandbox-isolation, SSRF, or credential-separation guarantee, or the
package-export/publishing contract. If everything comes back clean, state that
plainly.
