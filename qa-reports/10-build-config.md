# Build & Configuration QA Report

## Summary

Audit of the monorepo build system, package configurations, and DevOps files across all four workspace packages (`aai`, `aai-ui`, `aai-cli`, `aai-server`) plus root-level tooling configs. Found 14 concrete issues ranging from a build output mismatch that would break `pnpm start` in aai-server, to stale schema references, documentation drift, and inconsistent engine constraints.

## Issues Found

### Issue 1: aai-server `start` script references wrong output filename

- **File**: `/home/user/agent/packages/aai-server/package.json:10`
- **Severity**: High
- **Description**: The `start` script runs `node dist/index.js`, but tsdown for this package uses ESM format without an `outExtensions` override. The default ESM output extension is `.mjs`, so the actual compiled file is `dist/index.mjs`. The Dockerfile correctly references `dist/index.mjs` (line 43), confirming the mismatch. Running `pnpm start` locally would fail with `MODULE_NOT_FOUND`.
- **Recommendation**: Either add `outExtensions: () => ({ js: ".js" })` to `packages/aai-server/tsdown.config.ts` (matching the `aai` and `aai-ui` configs), or change the start script to `node dist/index.mjs`.

### Issue 2: PORT mismatch between `.env.example` and `fly.toml`

- **File**: `/home/user/agent/packages/aai-server/.env.example:2` and `/home/user/agent/fly.toml:7`
- **Severity**: Medium
- **Description**: The `.env.example` sets `PORT=8787` while `fly.toml` sets `PORT="8080"` and the Dockerfile `EXPOSE`s 8080. A developer copying `.env.example` to `.env` and running locally would use port 8787, but production uses 8080. This is confusing and could cause issues if the port value is checked in health-check or metrics paths.
- **Recommendation**: Align `.env.example` to use `PORT=8080` to match the production configuration, or add a comment explaining the difference.

### Issue 3: Hardcoded version strings in source files drift from `package.json`

- **File**: `/home/user/agent/packages/aai-server/src/metrics.ts:146` and `/home/user/agent/packages/aai/telemetry.ts:28`
- **Severity**: Medium
- **Description**: `metrics.ts` has `metrics.getMeter("aai-server", "0.8.9")` and `telemetry.ts` has `const VERSION = "0.9.3"`. These must be manually kept in sync with their respective `package.json` version fields. If a version bump misses these, telemetry data will report stale versions.
- **Recommendation**: Import the version from `package.json` at build time (e.g., via a tsdown `define` config or a build-time constant), or use a script in the `version` lifecycle to update these.

### Issue 4: knip.json `$schema` points to v5 but installed version is v6

- **File**: `/home/user/agent/knip.json:1`
- **Severity**: Medium
- **Description**: The `$schema` URL is `https://unpkg.com/knip@5/schema.json` but the installed knip version in root `package.json` (line 28) is `"knip": "^6.0.5"`. The v5 schema may not validate new v6 config options, and IDE autocompletion/validation will be based on stale definitions.
- **Recommendation**: Update the schema URL to `https://unpkg.com/knip@6/schema.json`.

### Issue 5: biome.json `$schema` version lags behind installed version

- **File**: `/home/user/agent/biome.json:1`
- **Severity**: Low
- **Description**: The schema URL references `2.4.7` but the installed Biome version in root `package.json` (line 23) is `"@biomejs/biome": "^2.4.8"`. While minor, this means new rules or config options added in 2.4.8 may not have proper IDE validation.
- **Recommendation**: Update the schema URL to `https://biomejs.dev/schemas/2.4.8/schema.json`, or automate schema version updates alongside dependency bumps.

### Issue 6: aai-cli tsdown target is `node20` but `engines` requires `>=22.6`

- **File**: `/home/user/agent/packages/aai-cli/tsdown.config.ts:7` and `/home/user/agent/packages/aai-cli/package.json:41`
- **Severity**: Medium
- **Description**: The CLI bundle targets `node20` (downleveling syntax), but the `engines` field requires Node 22.6+. This means the bundle unnecessarily transpiles Node 22 features (like `using` declarations, `import.meta.resolve`) that are guaranteed available at runtime, potentially introducing polyfill overhead or subtle behavior differences.
- **Recommendation**: Change the tsdown target to `node22` to match the engine constraint and the other packages.

### Issue 7: Engine constraint inconsistency between root and packages

- **File**: `/home/user/agent/package.json:38` vs `/home/user/agent/packages/aai/package.json:128` (and all other package.json files)
- **Severity**: Low
- **Description**: The root `package.json` specifies `"node": ">=22.6 <25"` (with an upper bound), but all four workspace packages specify `"node": ">=22.6"` (no upper bound). When published to npm, the individual packages claim to support Node 25+ even though the monorepo does not test against it.
- **Recommendation**: Add the `<25` upper bound to the published packages (`aai`, `aai-ui`, `aai-cli`) so consumers get accurate compatibility signals, or remove it from the root if it is not enforced.

### Issue 8: CLAUDE.md documents wrong `check` script execution order

- **File**: `/home/user/agent/CLAUDE.md:19` (the "Full CI check" section)
- **Severity**: Low
- **Description**: CLAUDE.md describes the `pnpm check` order as: `install` -> `build` -> `typecheck` -> `lint` -> `vitest --coverage` -> `knip` -> `syncpack` -> `api-extractor` -> `templates` -> `markdownlint` -> `attw` -> `integration` -> `e2e`. The actual script (root `package.json` line 10) runs: `build` -> `typecheck` -> `lint` -> `api-extractor` -> `attw` -> `templates` -> `knip` -> `syncpack` -> `markdown` -> `integration` -> `e2e` -> `vitest --coverage`. Tests run last (not after lint), and `api-extractor`/`attw` run before `knip` (not after).
- **Recommendation**: Update CLAUDE.md to reflect the actual execution order.

### Issue 9: `@opentelemetry/api` should be a peer dependency in the SDK package

- **File**: `/home/user/agent/packages/aai/package.json:98`
- **Severity**: Medium
- **Description**: `@opentelemetry/api` is listed as a regular `dependency` in the SDK, but the OpenTelemetry project explicitly recommends it be a `peerDependency` (with an optional flag). When users install `@opentelemetry/sdk-node` alongside `@alexkroman1/aai`, they may get two copies of the API package, causing the global registration mechanism to break -- the SDK's `MeterProvider` would register on a different API instance than the one AAI uses.
- **Recommendation**: Move `@opentelemetry/api` to `peerDependencies` with `"optional": true` in `peerDependenciesMeta`, matching the pattern used for `hono` and `vitest`.

### Issue 10: aai-server version (0.8.9) is out of sync with other packages (0.9.3)

- **File**: `/home/user/agent/packages/aai-server/package.json:3`
- **Severity**: Low
- **Description**: `aai-server` is at version `0.8.9` while `aai`, `aai-ui`, and `aai-cli` are all at `0.9.3`. While the server is private and not published, having a significantly different version can cause confusion and makes the hardcoded version in `metrics.ts` (Issue 3) harder to track. It also suggests the server package was not included in recent changeset version bumps.
- **Recommendation**: Either align the version with the other packages, or explicitly document that aai-server follows an independent versioning scheme. Ensure changesets include the private package if aligned versioning is desired.

### Issue 11: aai-ui tsdown builds files not declared in package.json exports

- **File**: `/home/user/agent/packages/aai-ui/tsdown.config.ts:8-9` and `/home/user/agent/packages/aai-ui/package.json:9-25`
- **Severity**: Low
- **Description**: The tsdown config builds entry points for `types.ts`, `audio.ts`, `mount.tsx`, `mount-context.ts`, `signals.ts`, and all `_components/*.tsx` files, but `package.json` exports only declares `.`, `./styles.css`, `./session`, and `./components`. The extra built files are accessible via direct `dist/` path imports but not through the official exports map, which could lead to consumers relying on undocumented paths that break without notice.
- **Recommendation**: Either add exports entries for intentionally-public subpaths (e.g., `./audio`, `./mount`, `./signals`), or remove unnecessary entries from the tsdown config if they are only consumed internally.

### Issue 12: Root `preact` devDependency appears unnecessary

- **File**: `/home/user/agent/package.json:31`
- **Severity**: Low
- **Description**: The root `package.json` lists `"preact": "^10.29.0"` as a devDependency, but no root-level code imports Preact. The `aai-ui` package already declares Preact as both a `peerDependency` and `devDependency`. The root installation likely exists to satisfy workspace hoisting for `aai-ui`, but this should be handled by pnpm's workspace resolution without an explicit root dep.
- **Recommendation**: Remove `preact` from the root `devDependencies` unless it is specifically required for workspace hoisting. If it is needed, add a comment explaining why.

### Issue 13: aai-cli lists `hono` and `@hono/node-server` as direct dependencies but never imports them

- **File**: `/home/user/agent/packages/aai-cli/package.json:23-24`
- **Severity**: Low
- **Description**: `hono` (^4.12.9) and `@hono/node-server` (^1.19.11) are listed as runtime dependencies in `aai-cli`, but no source file in the package imports from either. These are used by `@alexkroman1/aai/server` (which declares them as optional peer dependencies). The CLI bundles the dev server via the `aai` workspace dependency, so these deps are installed to satisfy the peer requirement at runtime. However, listing them as direct deps in the CLI package (which is published) means they are always installed for end users even when not needed.
- **Recommendation**: Move these to `peerDependencies` with `optional: true` in `peerDependenciesMeta`, or document why they must be direct dependencies (e.g., required for `aai dev` and `aai start` commands).

### Issue 14: aai-server `main` field points to TypeScript source, not build output

- **File**: `/home/user/agent/packages/aai-server/package.json:6`
- **Severity**: Low
- **Description**: The `main` field is set to `src/index.ts`, which works for development (Node with `--experimental-strip-types` or loaders) but is unconventional. The `start` script runs `node dist/index.js` (the compiled output), creating a disconnect. Unlike the published packages which use `exports` with `source` conditions for dev and `import` for production, aai-server has only a `main` field with no `exports` map.
- **Recommendation**: Since the package is private and only used in the monorepo, either switch `main` to the compiled output path and use `dev` script for source execution, or add an `exports` map with `source`/`import` conditions matching the pattern in other packages.
