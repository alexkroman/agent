# CLI Package Simplification

Refactor `packages/aai-cli/` to reduce cognitive load and eliminate duplication while preserving all CLI behavior (minor user-facing improvements allowed).

## Approach

Split the overloaded `_discover.ts`, consolidate shared API error handling, replace custom code with existing library features, and update all test files to match.

## Changes

### 1. Split `_discover.ts` into focused modules

`_discover.ts` (233 lines) mixes 5 responsibilities. Split into:

- **`_config.ts`** (~100 lines): Auth config I/O (`getConfigDir`, `readAuthConfig`, `writeAuthConfig`, `getApiKey`, `ensureApiKeyInEnv`), project config (`readProjectConfig`, `writeProjectConfig`, `ProjectConfig`, `getServerInfo`), Zod schemas.
- **`_agent.ts`** (~60 lines): Agent discovery (`loadAgent`, `AgentEntry`), dev mode (`getMonorepoRoot`, `isDevMode`), server URL resolution (`resolveServerUrl`, `DEFAULT_SERVER`, `DEFAULT_DEV_SERVER`).
- **`_utils.ts`** (~15 lines): `resolveCwd()`, `fileExists()`.

Delete `_discover.ts`. Update all imports.

### 2. Eliminate `_prompts.ts`, simplify `_ui.ts`

**Delete `_prompts.ts`** (52 lines). Replace custom `askPassword`/`readMasked` with `@clack/prompts` `p.password()`. Update call sites in `_config.ts` (was `_discover.ts`) and `secret.ts`. Move CI/non-TTY guards to call sites that need them.

**Simplify `_ui.ts`** (39 -> ~15 lines). The `log` object is a 1:1 pass-through to `p.log`. Re-export directly: `export { log } from "@clack/prompts"`. Keep `fmtUrl` and `parsePort` in this file.

### 3. Consolidate API error handling

Add `apiRequestOrThrow` to `_api-client.ts`. Wraps `apiRequest` + non-ok response handling with status-specific hints via an optional `hints` map:

```ts
export async function apiRequestOrThrow(
  url: string,
  init: RequestInit & { apiKey: string; action: string },
  opts?: { hints?: Record<number, string>; fetch?: typeof globalThis.fetch },
): Promise<Response>
```

Simplify `_deploy.ts`, `_delete.ts`, and `secret.ts` to use this — each drops ~8 lines of duplicated error handling.

### 4. Zod schema for `loadAgentDef`, README template extraction

**`_server-common.ts`**: Replace manual `typeof` field validation in `loadAgentDef` with a Zod schema (`AgentDefSchema`). Consistent with how config files are already validated.

**`_init.ts`**: Extract the 35-line inline README template into a `readmeContent(slug)` function at the top of the file.

### 5. Test file updates

- **Split `_discover.test.ts`** into `_config.test.ts` and `_agent.test.ts` matching the source split.
- **Update imports** in all test files to point at new modules.
- **Update mocks**: tests mocking `askPassword` from `_prompts.ts` switch to mocking `@clack/prompts` `p.password`.
- No changes to test logic or assertions beyond what's needed for the new module boundaries.

## File inventory

| Action | File | Notes |
|--------|------|-------|
| Create | `_config.ts` | ~100 lines from `_discover.ts` |
| Create | `_agent.ts` | ~60 lines from `_discover.ts` |
| Create | `_utils.ts` | ~15 lines from `_discover.ts` |
| Delete | `_discover.ts` | 233 lines |
| Delete | `_prompts.ts` | 52 lines, replaced by `@clack/prompts` |
| Simplify | `_ui.ts` | 39 -> ~15 lines |
| Simplify | `_api-client.ts` | +20 lines (`apiRequestOrThrow`) |
| Simplify | `_deploy.ts` | 50 -> ~30 lines |
| Simplify | `_delete.ts` | 33 -> ~20 lines |
| Simplify | `secret.ts` | 57 -> ~40 lines |
| Simplify | `_server-common.ts` | Zod schema for `loadAgentDef` |
| Simplify | `_init.ts` | Extract README template fn |
| Update | `cli.ts`, `init.ts`, `dev.ts`, `deploy.ts`, `delete.ts`, `test.ts` | Import paths |
| Split | `_discover.test.ts` | -> `_config.test.ts` + `_agent.test.ts` |
| Update | All other test files | Import paths + mock updates |

## Constraints

- Behavior-preserving: same CLI flags, same commands, same exit codes.
- Minor user-facing changes OK (e.g., `@clack/prompts` password style).
- No new dependencies. No directory restructuring.
- All tests must pass after refactor.
