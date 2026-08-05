# @alexkroman1/aai-cli — the `aai` CLI

init, dev, test, build, list, pull, push, publish, delete, login, secret,
storage, templates (`deploy` is hidden/internal — the mechanism in-guest
Publish runs). Repo-wide commands and conventions live in the root
[CLAUDE.md](../../CLAUDE.md).

## Key files

- `cli.ts` — arg parsing, subcommand dispatch
- `_cli-common.ts` — shared citty plumbing (`sharedArgs`, `setup`,
  `runCommand`); `_studio-commands.ts` — the list/pull/push/publish command
  definitions
- `init.ts` / `dev.ts` / `test.ts` / `deploy.ts` (internal) / `delete.ts` /
  `secret.ts` — subcommand entry points
- `studio.ts` / `_studio.ts` — the studio round-trip: pull/push/publish
  executors over the `/studio/projects` routes, the local source walk
  (guest-snapshot ignore rules + cap mirrors, `.env`/lockfiles never sync)
- `_init.ts` / `_deploy.ts` / `_bundler.ts` — internal logic
- `_dev-server.ts` — dev server for directory-based agents: loads `agent.ts`,
  builds runtime, watches for file changes, optionally runs Vite for client HMR
- `_bundler.ts` — bundles `agent.ts` (and optional `client.tsx`) into
  deployable artifacts
- `_api-client.ts` — platform API client (`apiRequest`, `apiRequestOrThrow`)
- `_config.ts` — auth config, project config, API key management
- `_agent.ts` — agent discovery, dev mode detection, server URL resolution
- `_utils.ts` — shared utilities (`resolveCwd`, `fileExists`)
- `_server-common.ts` — shared server utilities
- `_templates.ts` — template handling
- `_ui.ts` — CLI output helpers (`log`, `fmtUrl`, `parsePort`)

## CLI credential destinations (`aai-cli/_agent.ts`)

`.aai/project.json` is in the working tree, so a cloned repo controls its
`serverUrl` — and `aai deploy` / `aai secret` pair that URL with the user's API
key and secret values. `resolveServerUrl` therefore honors a config-supplied
origin only when it is the shipped default or already in `approvedServers` in
the user-owned global config. Loopback origins are deliberately NOT implicitly
trusted from config — a repo-supplied `http://localhost:<port>` would hand the
key to whatever is listening on that local port (dev mode targets its own
default server before the project config is consulted, so `aai dev` workflows
are unaffected). Passing `--server` is what approves an origin (it is user
intent, not repo content) and is remembered for later commands. Never widen
this to trust `serverUrl` directly.

The `slug` from the same file is validated against the platform's slug shape
(`VALID_SLUG_RE`, shared with aai-server via `@alexkroman1/aai/utils` —
`sdk/slug.ts` is the single definition) before it is ever
interpolated into a URL path, so a hostile `"slug": "x/../admin"` cannot steer
a credentialed request; `aai secret delete` also URL-encodes the secret name.
**That check lives in `resolveDeployTarget`** — the one point where
repo-controlled config becomes a credentialed target — so every command
inherits it. It used to live in `getServerInfo` only, which covered
secret/storage/delete but NOT `publish`, whose `syncEnvSecrets` PUTs the whole
`.env` to `${serverUrl}/${slug}/secret`; one guard in two places, with the
copy missing from the command users actually run.

The API key itself is stored 0600 in the global `config.json`
(`AAI_CONFIG_DIR` overrides the config dir location).
**`ensureApiKey` has exactly two sources: the key `aai login` saved, then
`ASSEMBLYAI_API_KEY` for non-interactive callers.** There is no "paste a key"
prompt — it produced a CLI that could push and publish while linked to no
account the user could see in the studio, and it made `aai login` optional in
practice. It was also the riskier path: a hidden password prompt reads stdin,
so a piped invocation could have its input eaten and persisted as the API key.
Unauthenticated commands fail with `not_logged_in` pointing at `aai login`.

**Tests must never resolve the real config dir.** `getConfigDir()` returns a
per-process temp dir whenever `VITEST` is set (unless `AAI_CONFIG_DIR` says
otherwise), and `aaiEnv()` sets `AAI_CONFIG_DIR` for the CLIs the e2e suite
spawns. The guard is in the code path, not a vitest setup file, because
setup files are per-config and any config can omit one — `vitest.slow.config.ts`
(integration + e2e) declared none, so `_test-setup.ts` never ran for those
suites and real configs accumulated ~100 approved loopback origins plus
`https://override.com`. That matters because `approvedServers` is the trust
anchor for a repo-supplied `serverUrl`: a pre-approved loopback origin lets a
cloned repo's `.aai/project.json` collect the developer's API key and secret
values with no prompt, which is exactly what the loopback tightening above
removed. Spawned CLI children run with `VITEST` cleared (or the CLI skips
`main()`), so both halves are needed.

Note also that `aai build` and `aai dev` evaluate the repository's bundled
`agent.ts` in the host process (`evalWorkerBundle`, via a `data:` URL
import) — running either against an untrusted clone executes that repo's
code locally. `aai deploy` no longer does: every worker self-describes its
config (`__aaiConfig`, generated by `buildWorker`'s wrapper entry) and the
server extracts it guest-side (`extractAgentConfig` → `describeBundle`), so
the deploy path uploads without evaluating. A bare `aai` in a project still
asks for confirmation on a TTY before implicitly deploying.
