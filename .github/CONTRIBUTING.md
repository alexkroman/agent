# Contributing to AAI

Thanks for your interest in contributing! This guide will help you get started.

## Getting started

```sh
# 1. Fork and clone the repo
git clone https://github.com/<your-user>/agent.git
cd agent

# 2. Install dependencies (requires Node >=22.6, pnpm 10.x)
pnpm install

# 3. Run the full check suite to make sure everything works
pnpm check
```

## Development workflow

1. **Create a branch** from `main` for your change.
2. **Make your changes.** Tests are co-located: `foo.ts` → `foo_test.ts`.
3. **Run checks locally** before pushing:

   ```sh
   pnpm test          # unit tests
   pnpm typecheck     # type-check all packages
   pnpm lint          # Biome linter
   ```

   Or run everything at once: `pnpm check`
4. **Push and open a PR** against `main`. CI will run automatically.

## Monorepo structure

| Package | Description |
| ------- | ----------- |
| `packages/aai` | Core SDK (`defineAgent`, `createRuntime`, `createServer`, types) |
| `packages/aai-ui` | Browser client (Preact) |
| `packages/aai-cli` | The `aai` CLI tool |
| `packages/aai-server` | Managed platform server (private) |

Packages depend on `aai` via `workspace:*` but never on each other.

## Running specific tests

```sh
pnpm --filter @alexkroman1/aai test          # Single package
pnpm vitest run packages/aai/types_test.ts    # Single file
```

## Changesets

If your PR affects a published package (`aai`, `aai-ui`, or `aai-cli`), run
`pnpm changeset` to generate a changeset file describing your change. This
drives the changelog and version bumps.

Changes that only affect CI, docs, or `aai-server` (private) don't need a
changeset.

## Code style

- **Biome** handles linting and formatting. The pre-commit hook auto-fixes
  staged files, so you rarely need to think about it.
- No focused or skipped tests (`.only` / `.skip`) — CI will catch these.
- Keep files under 400 lines and functions under 150 lines.
- Use `import type` for type-only imports.

## PR guidelines

- Keep PRs focused — one logical change per PR.
- Fill out the PR template.
- CI must pass before merge. The `ci` status check gates all individual jobs.
- Maintainers may request changes or add labels. PRs are squash-merged.

## Reporting issues

Open an issue on GitHub. For security vulnerabilities, email the maintainers
directly instead of opening a public issue.
