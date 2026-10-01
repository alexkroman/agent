# Contributing to AAI

Thanks for contributing! This is the human quickstart. The full rules for the
repo — test tiers, naming, import boundaries, gates — are in
[`AGENTS.md`](../AGENTS.md), which coding agents read too; step-by-step
procedures live in [`.claude/skills/`](../.claude/skills/) (`pr-workflow`,
`changeset-release`, `api-contract-epoch-bump`, `expose-guest-route`), and
every package has its own `CLAUDE.md` guide (`pnpm docs:list` prints them all).

## Prerequisites

- **Node 24** — `.node-version` says `24`, and the root `package.json` accepts
  `>=24 <27`. With [fnm](https://github.com/Schniz/fnm): `fnm use`.
- **pnpm 10.29.3** — pinned by `packageManager`; `corepack enable` picks it up.

## The loop: clone → test → check → changeset → PR

```sh
git clone https://github.com/alexkroman/agent.git
cd agent
pnpm install                              # also installs the lefthook git hooks

pnpm test:aai-core                        # one package's unit tests (see AGENTS.md for the rest)
pnpm --filter @alexkroman1/aai test       # the same, through the package's own script
pnpm vitest run packages/aai/src/sdk/protocol.test.ts                       # one file
pnpm vitest run packages/aai/src/sdk/protocol.test.ts -t "protocol constants" # one test by name

pnpm check:local                          # the fast pre-commit gate: lint, typecheck, unit tests, ratchets
```

1. **Branch from `main`** and make your change. Tests are co-located:
   `foo.ts` → `foo.test.ts` (unit). The tier is the suffix —
   `foo.integration.test.ts`, `foo.scenario.test.ts`, `foo.eval.test.ts` — and
   the table of what each tier may touch is "Test tiers" in `AGENTS.md`.
2. **Run `pnpm check:local`** before the first commit. The pre-commit hook runs
   Biome on staged files; the pre-push hook blocks a push to `main`, a branch
   behind or conflicting with `origin/main`, a missing changeset and a failing
   check (`lefthook.yml` has the exact list).
3. **Add a changeset** (see below), rebase on `origin/main`, push, and open a PR
   against `main`. Fill out the PR template; CI's `check` job must pass, and PRs
   are squash-merged.

## Packages

Thirteen workspace packages under `packages/`. Filter by the npm name in the
middle column (`pnpm --filter <name> …`):

| Directory                     | npm name                   | What it is                                                     |
| ----------------------------- | -------------------------- | -------------------------------------------------------------- |
| `packages/aai/`               | `@alexkroman1/aai`         | Shared core SDK: agent config, types, protocol, S2S, session   |
| `packages/aai-ui/`            | `@alexkroman1/aai-ui`      | Browser client (React 19): session, audio, UI components       |
| `packages/aai-runtime/`       | `@alexkroman1/aai-runtime` | The host runtime that runs an `agent.ts`                       |
| `packages/aai-cli/`           | `@alexkroman1/aai-cli`     | The `aai` CLI                                                  |
| `packages/aai-guest/`         | `aai-guest`                | Guest sandbox harness (private)                                |
| `packages/aai-guest-core/`    | `aai-guest-core`           | Modules both guest modes share (private)                       |
| `packages/aai-guest-studio/`  | `aai-guest-studio`         | The studio coding agent as it runs in a guest (private)        |
| `packages/aai-server/`        | `aai-server`               | Agent service and shared platform core (private)               |
| `packages/aai-studio-server/` | `aai-studio-server`        | Studio service and the deployment's composition root (private) |
| `packages/aai-studio-client/` | `aai-studio-client`        | The studio's browser front-end (private)                       |
| `packages/aai-templates/`     | `aai-templates`            | Agent templates and the project scaffold (private)             |
| `packages/aai-gates/`         | `aai-gates`                | Meta-gate suite for the repo's own checks (private)            |
| `packages/aai-evals/`         | `aai-evals`                | Behaviour eval library (private)                               |

Every package depends on `@alexkroman1/aai`; the allowed edges between the rest
are "Dependency flow" in `AGENTS.md`. Cross-package imports use the npm name,
never a relative path, and `_foo.ts` files are package-internal.

## Changesets

Every PR that changes anything under `packages/` (or `supabase/migrations/`)
needs a changeset; the pre-push hook and CI run
`pnpm changeset status --since=origin/main`. The full rules are in
[`.agents/releases.md`](../.agents/releases.md) and the `changeset-release`
skill. In short:

```sh
# A releasable change (non-interactive; --pkg may repeat):
pnpm changeset:create --pkg @alexkroman1/aai --bump patch --summary "Fix X"
# A change that should not release anything (tests, internal refactors, docs):
pnpm changeset add --empty
```

- `@alexkroman1/aai`, `aai-ui`, `aai-cli` and `aai-runtime` are one **fixed
  release group**: naming one bumps all four.
- Private packages are versioned too. A platform change ships only when
  `aai-server` or `aai-studio-server` is named — and `aai-studio-client` /
  `aai-guest` changes must name one of those two as their carrier, or they ship
  to nothing (`guard-invariants` rule 20).
- An EMPTY changeset is rejected on a branch that changes shipped platform
  source or `supabase/migrations/**` (`check:deploy-changeset`).

## Code style

- **Biome** lints and formats TS/JS/JSON/CSS/HTML (`pnpm lint`,
  `pnpm lint:fix`); **Prettier** formats Markdown, YAML, shell and Dockerfiles.
  `pnpm format` runs every fixer. Filenames are kebab-case.
- **File length**: source files are capped at 500 lines and tests at 700,
  counted like `wc -l` (comments and blank lines included);
  `pnpm check:file-length` reports headroom. Templates are exempt, and
  `scripts/file-length-allowlist.json` holds the grandfathered files.
- No focused or skipped tests (`.only` / `.skip`), and no test tier retries.
- Use `import type` for type-only imports, `p-timeout` for timeouts and
  `AbortSignal.any` to combine signals.

## Running the platform locally (`pnpm dev:aai-server`)

`pnpm dev:aai-server` runs `aai-studio-server`'s `dev` script — the combined
deployment (studio + agent service) on `http://localhost:8080` — through
`scripts/dev-server.mjs`. Its `predev` first checks the Node version, rebuilds
the guest harness and (if Docker is available) the local guest image when their
inputs changed, and builds `aai-studio-client`. The wrapper then supplies:

- **`AAI_LOCAL_DEV=1`**, which permits the isolation-free `subprocess` sandbox
  backend and makes the AssemblyAI key verifier optional;
- **`AAI_PUBLIC_ORIGIN`** (`http://localhost:<PORT>`) unless you set it;
- **the local Supabase stack's env** (`SUPABASE_DB_URL` and friends), read from
  `supabase status -o env`. With no stack running it warns and runs on memory
  stores, so a restart erases every deployed agent and workspace.

Setup:

1. Install the [Supabase CLI](https://supabase.com/docs/guides/cli)
   (`brew install supabase/tap/supabase`, or `npx supabase`) and Docker, then
   run `supabase start` from the repo root for the durable tier (it is never
   started for you).
2. Copy `packages/aai-server/.env.example` to **`.env` at the repo root** (the
   file `scripts/dev-server.mjs` loads) and fill in what you need — provider
   keys, or a scratch Supabase project. Shell variables beat the file, and the
   file beats the resolved local stack.
3. `pnpm dev:aai-server`. `node scripts/dev-server.mjs --print` shows what it
   would resolve, and why.

Postgres-backed scenario suites skip without a database; `pnpm test:pg` runs
them against the local stack.

## Optional local tools that CI requires

`pnpm check` announces a SKIP when one of these is missing locally; CI installs
them and turns the skip into a failure. Versions are pinned in
`.github/workflows/check.yml`:

```sh
# macOS: brew install shellcheck pipx   ·   Debian/Ubuntu: apt install shellcheck pipx
pipx install zizmor==1.30.1
pipx install actionlint-py==1.7.12.25
pipx install yamllint==1.38.0
pipx install ruff==0.16.9
pipx install sqlfluff==4.3.0
pipx install hadolint-bin==2.15.1

# The e2e tier's browser:
pnpm --filter @alexkroman1/aai-cli exec playwright install --with-deps chromium
```

## Reporting issues

Open an issue on GitHub. For security vulnerabilities, email the maintainers
directly instead of opening a public issue.
