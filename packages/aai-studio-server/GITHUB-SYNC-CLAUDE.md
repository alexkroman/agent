---
summary: >-
  Sync to GitHub: the GitHub App connect flow, the unauthenticated callback's
  two guards, the one-commit Git Data API push, the empty-repository
  bootstrap, and ref-conflict retries
read_when: >-
  editing `src/studio-github-*.ts`, the client's `github-card.tsx`, or the
  GitHub App's configuration
---

# packages/aai-studio-server — Sync to GitHub

A SIBLING of this package's guides, read on demand. The code is
`src/studio-github-*.ts` plus the client's `components/github-card.tsx`: a
signed-in account connects a **GitHub App installation**, picks a repository,
and pushes a project's workspace to a branch as ONE commit.

## Sync to GitHub

### Authorization

- **A GitHub App, not the sign-in GitHub OAuth.** Supabase Auth stays the
  identity layer. Reusing the sign-in would demand `repo` (every repository)
  of every user at login; `provider_token` is handed over once and never
  refreshed; and uninstalling an App is a revocation the user controls.
  Installation tokens are minted per request with `@octokit/auth-app` — never
  mint a token or sign a JWT by hand.
- **Absent configuration DISABLES the feature, never fails a boot.**
  `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_SLUG`, all or none;
  `GET /studio/github` answers `configured: false` and the card renders
  nothing. The PEM is normalized (intact, `\n`-escaped, base64) and trimmed —
  it is also the state HMAC key, so replicas must agree byte-for-byte.
- **Connect goes through `/login/oauth/authorize`, never the App's install
  page** — `apps/<slug>/installations/new` redirects back only on a FIRST
  install, so an already-installed App never reached the callback. The
  authorize endpoint always returns a `code` and offers install when needed.
  **The App's Callback URL must be `<origin>/studio/github/callback`**; GitHub
  uses the first registered one whatever `redirect_uri` says, so send none.
- **The callback is the one studio route that cannot authenticate its
  caller** (a top-level navigation from github.com). Both guards are required:
  the `state` is HMAC-signed with a key derived from the App's private key
  (else `?state=` is an attacker-chosen user id), and the installation is
  resolved against GitHub as the App before anything is stored (the signature
  proves who asks, never what they attach). The state carries a 10-minute
  `exp`, is compared in constant time, and is minted at CLICK time by
  `POST /studio/github/connect`. Every exit is a REDIRECT with `?github=`,
  never JSON.
- **Which installation comes from the user token, not the redirect.**
  `GET /user/installations` (already scoped to this App): a redirect that
  names an `installation_id` must find it in that list (the cross-tenant
  refusal); one that names none takes the newest entry (the card names the
  account and links to GitHub's picker). An empty list redirects to the
  install page with a fresh state.
- **The link is keyed by studio USER** (`github-install:<uid>` in the
  SecretStore beside `user-key:<uid>`, schema-validated on read). An
  unclaimed raw-key caller is refused — never widened to the workspace scope.

### The push

- **Git Data API, tree written WHOLE**: blobs → tree → commit → ref, no clone,
  no `base_tree`. A sync REPLACES the branch's tree (a studio deletion deletes
  there; a file added on the branch is removed next sync — one-way sync).
- **The ref PATCH is never forced** — a non-fast-forward means someone pushed
  during the upload. The sync re-reads the head and rebuilds onto it
  (`REF_CONFLICT_RETRIES`; blobs and tree are content-addressed). A create
  answering 422 "Reference already exists" switches to update; one refused
  while the ref still does not exist surfaces GitHub's own words.
  **"That branch moved… try again" comes only from `GithubRefConflictError`**,
  raised after the retries are spent — never map a generic 409/422 to it.
- **What is committed is a PROJECT**: `layerScaffoldFiles`
  (`@alexkroman1/aai/workspace-files`, the rule `aai pull` applies) over the
  scaffold `studio-scaffold.ts` resolves. `scaffold` is a REQUIRED parameter
  of `syncWorkspaceToGithub`.
- **An empty repository closes the Git Data API** (`POST /git/blobs` → 409
  `Git Repository is empty.`). `initializeRepo` reacts to that refusal (a ref
  404 cannot tell empty from branch-missing) by writing ONE real workspace
  file (the first, sorted) through the Contents API, naming NO branch (an
  empty repository accepts only its default branch), then the sync proceeds.
  ONE attempt — a 409 still standing afterwards is not an empty repository.
- **Idempotent on the workspace `hash`** (`hasGithubChanges`), recorded as
  `githubRepo`/`githubBranch`/`githubHash`/`githubCommit` via
  `stampWorkspaceMeta` (no files, so no reverted edit). The no-op is checked
  AFTER reading the branch head and only against the SAME target.
- **The branch is the repository's own default** (`readRepoDefaultBranch`, read
  at push time), never a request field. Adding a branch control means adding
  its grammar with it.
- **Repository CREATION is organizations only** — `POST /user/repos` is closed
  to installation tokens. Answer a personal account with the instruction, not
  GitHub's 403. The picker lists the INSTALLATION's repositories,
  newest-first (`pickerOrder`, reversed rather than sorted).
- **Metered** by `GITHUB_SYNC_RATE_LIMIT` (scope + IP) from
  `createPgStudioRateLimiters` — see "Rate limits" in `src/CLAUDE.md`.

### Testing

`_studio-github-test-utils.ts` is a fake GitHub behind Octokit's own `fetch`
seam with a real RSA key, so App JWT minting and token exchange really run and
the invisible properties (no `base_tree`, unforced PATCH, empty-repository
path) are assertable. An unrecognized path answers **501 naming it**. Do not
mock `syncWorkspaceToGithub` or our own wrappers.
