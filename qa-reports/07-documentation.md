# Documentation QA Report

## Summary
Audit of documentation across all packages found 14 concrete issues ranging from stale comments referencing nonexistent files, contradictory JSDoc descriptions of where built-in tools execute, missing exports and templates in documentation, to incorrect code examples. Most issues are medium severity -- they cause confusion but do not break builds.

## Issues Found

### Issue 1: CLAUDE.md says "16 templates" but there are 18
- **File**: /home/user/agent/CLAUDE.md:100
- **Severity**: Low
- **Description**: The line in CLAUDE.md under Conventions states "16 agent scaffolding templates" but the actual `packages/aai-cli/templates/` directory contains 18 templates (the 16 listed plus `test-patterns` and `middleware` were added later but the count was never updated; `middleware` is listed in the template table but the count was not bumped).
- **Recommendation**: Update the count to 18 to match reality.

### Issue 2: Template CLAUDE.md omits the `test-patterns` template
- **File**: /home/user/agent/packages/aai-cli/templates/_shared/CLAUDE.md:56-72
- **Severity**: Medium
- **Description**: The template table in the agent API reference lists 17 templates but omits `test-patterns`, which exists at `packages/aai-cli/templates/test-patterns/`. Users scaffolding from a template would not know this option exists.
- **Recommendation**: Add a row for `test-patterns` to the template table.

### Issue 3: CLAUDE.md CLI subcommands list is incomplete
- **File**: /home/user/agent/CLAUDE.md:92
- **Severity**: Medium
- **Description**: Line 92 says `Binary: aai -- subcommands: init, dev, build, deploy, start, secret, rag, link` but omits both `test` and `unlink`. The actual CLI (cli.ts line 209) registers: `init, dev, test, build, deploy, start, secret, rag, link, unlink`. Note that line 45 of the same file correctly includes `test` in the package table description but still omits `unlink`.
- **Recommendation**: Update line 92 to include all subcommands: `init, dev, test, build, deploy, start, secret, rag, link, unlink`.

### Issue 4: CLAUDE.md claims `./runtime` exports `Metrics` but it does not exist
- **File**: /home/user/agent/CLAUDE.md:67
- **Severity**: Medium
- **Description**: The CLAUDE.md internal exports section states `./runtime -- Logger, Metrics, S2SConfig interfaces`. However, `packages/aai/runtime.ts` exports only `Logger`, `LogContext`, `S2SConfig`, `consoleLogger`, and `DEFAULT_S2S_CONFIG`. There is no `Metrics` type or interface anywhere in the file.
- **Recommendation**: Change the description to `./runtime -- Logger, LogContext, S2SConfig interfaces, consoleLogger, DEFAULT_S2S_CONFIG`.

### Issue 5: CLAUDE.md missing `./testing/matchers` export
- **File**: /home/user/agent/CLAUDE.md:62-63
- **Severity**: Low
- **Description**: The public exports for `@alexkroman1/aai` list `./testing` but do not mention `./testing/matchers`, which is defined in `package.json` (line 34-37) and provides Vitest custom matchers (`toHaveCalledTool`). This is a public export used by agent tests.
- **Recommendation**: Add `./testing/matchers -- Vitest custom matchers (toHaveCalledTool)` to the public exports list.

### Issue 6: Contradictory JSDoc about where built-in tools execute
- **File**: /home/user/agent/packages/aai/builtin-tools.ts:5 vs /home/user/agent/packages/aai/types.ts:98
- **Severity**: High
- **Description**: The module JSDoc in `builtin-tools.ts` (line 5) states "These tools run inside the sandboxed worker alongside custom tools." However, `types.ts` (line 98) states "Built-in tools run on the host process (not inside the sandboxed worker)." The `types.ts` description is correct for platform mode (sandbox.ts runs tools on the host). In self-hosted mode (`direct-executor.ts`), all tools run in-process. The `builtin-tools.ts` comment is misleading.
- **Recommendation**: Update the `builtin-tools.ts` module JSDoc to: "Built-in tool definitions for the AAI agent SDK. In self-hosted mode, these run in-process alongside custom tools. In platform mode, they run on the host process outside the sandbox."

### Issue 7: `ws-handler.ts` references nonexistent `host.ts`
- **File**: /home/user/agent/packages/aai/ws-handler.ts:5
- **Severity**: Medium
- **Description**: The module comment says "Audio validation is handled at the host transport layer (see host.ts)." No file named `host.ts` exists anywhere in the `packages/aai/` directory. This appears to be a stale reference to a file that was renamed or removed.
- **Recommendation**: Either remove the parenthetical reference or update it to point to the correct file (likely `server.ts` or `direct-executor.ts`).

### Issue 8: `server.ts` and `sandbox.ts` reference nonexistent "WintercServer"
- **File**: /home/user/agent/packages/aai/server.ts:7, /home/user/agent/packages/aai-server/src/sandbox.ts:8
- **Severity**: Low
- **Description**: Both files reference "WintercServer" in comments (e.g., "no intermediate WintercServer layer", "no WintercServer or proxy AgentDef needed"). There is no `WintercServer` class or type anywhere in the codebase. This appears to be a stale reference to a previous internal abstraction that was removed.
- **Recommendation**: Remove or rephrase these references. For example, `server.ts` line 7 could say "Calls createDirectExecutor + wireSessionSocket directly -- no intermediary needed."

### Issue 9: `AgentOptions` JSDoc example includes nonexistent `voice` property
- **File**: /home/user/agent/packages/aai/types.ts:310
- **Severity**: Medium
- **Description**: The JSDoc example for `AgentOptions` includes `voice: "orion"` in the `defineAgent()` call, but `AgentOptions` has no `voice` property. The `voice` field does not appear anywhere in the type definition (lines 324-383). This would mislead users into thinking they can configure a TTS voice.
- **Recommendation**: Remove `voice: "orion"` from the example, or add a `voice` property to the type if this feature is planned.

### Issue 10: Template CLAUDE.md uses bare `"aai"` imports instead of `"@alexkroman1/aai"`
- **File**: /home/user/agent/packages/aai-cli/templates/_shared/CLAUDE.md:79,91,188,351,442,921
- **Severity**: Medium
- **Description**: All code examples in the template CLAUDE.md use bare package names like `import { defineAgent } from "aai"` and `import { mount } from "aai-ui"`, while every actual template file uses the scoped names `@alexkroman1/aai` and `@alexkroman1/aai-ui`. There is no bundler alias or tsconfig path mapping that resolves bare `"aai"` to the scoped package. Users copying examples from the docs would get module-not-found errors.
- **Recommendation**: Either update all CLAUDE.md examples to use `@alexkroman1/aai` and `@alexkroman1/aai-ui`, or add a note explaining that the CLI bundler resolves these aliases automatically (if that is the case).

### Issue 11: `visit_webpage` documented as returning Markdown but actually returns plain text
- **File**: /home/user/agent/packages/aai-cli/templates/_shared/CLAUDE.md:238
- **Severity**: Low
- **Description**: The built-in tools table describes `visit_webpage` as "Fetch URL -> Markdown". However, the actual implementation in `builtin-tools.ts` (line 104) uses the `html-to-text` library to convert HTML to plain text, not Markdown. The tool description itself says "return its content as clean text."
- **Recommendation**: Change the table entry from "Fetch URL -> Markdown" to "Fetch URL -> plain text".

### Issue 12: Hardcoded version string in telemetry.ts duplicates package.json version
- **File**: /home/user/agent/packages/aai/telemetry.ts:28
- **Severity**: Low
- **Description**: `telemetry.ts` hardcodes `const VERSION = "0.9.3"` which must be manually kept in sync with `package.json` version `"0.9.3"`. This is a maintenance hazard -- if the package version is bumped without updating this file, OpenTelemetry scope metadata will report the wrong version.
- **Recommendation**: Read the version from `package.json` at build time or use a shared constant.

### Issue 13: Template CLAUDE.md documents `aai build` as "Run tests, then bundle and validate"
- **File**: /home/user/agent/packages/aai-cli/templates/_shared/CLAUDE.md:37
- **Severity**: Low
- **Description**: The CLI commands section says `aai build` will "Run tests, then bundle and validate." However, the actual `build` subcommand in `cli.ts` (line 79) has a `--skipTests` flag and the `_build.ts` logic is just bundling. The `build` command itself calls `runVitest` before `runBuildCommand` only if `!args.skipTests`. The template `package.json` maps `"build"` to `aai deploy --dry-run`, not `aai build`. This is potentially confusing.
- **Recommendation**: Clarify that `aai build` runs tests by default but can skip them with `--skipTests`, and note that the template's npm `build` script uses `aai deploy --dry-run` instead.

### Issue 14: `.env.example` references CLI-managed API key but provides no actionable guidance
- **File**: /home/user/agent/packages/aai-cli/templates/_shared/.env.example:4
- **Severity**: Low
- **Description**: The `.env.example` file states "ASSEMBLYAI_API_KEY is managed globally by the CLI (~/.config/aai/)" but does not explain how to set it up initially (e.g., `aai init` prompts for it, or the user can set it manually). A new user seeing this file would not know what to do.
- **Recommendation**: Add a comment like "# Run `aai init` to set up your API key, or set ASSEMBLYAI_API_KEY in ~/.config/aai/config.json".
