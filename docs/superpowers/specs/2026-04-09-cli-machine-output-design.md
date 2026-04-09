# CLI Machine Output: Optimizing `aai` for Claude Code

## Problem

The `aai` CLI is optimized for human interaction: colored `@clack/prompts`
output, interactive prompts, and unstructured text errors. When Claude Code
runs CLI commands via shell, it must parse human-readable text to understand
results — fragile, lossy, and breaks when output formatting changes.

## Goal

Make every `aai` command emit structured JSON in non-interactive contexts so
Claude Code can reliably build and deploy voice agents without parsing
human-readable output.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Output mode selection | Auto-detect non-TTY + `--json`/`--no-json` overrides | Zero-config for Claude Code (runs in pipe), humans unaffected |
| Implementation pattern | Command wrapper (`withOutput`) | Per-command migration, commands return data instead of printing |
| Secret input (non-TTY) | Read from stdin | Unix convention, avoids leaking secrets in process list |
| Error reporting | JSON body with error codes, exit 0/1 only | Claude Code reads output, doesn't branch on exit codes |
| New commands | None | Existing 7 commands cover the full workflow |

## Output Mode Detection

The CLI determines output mode once at startup:

1. `--json` flag present → JSON mode
2. `--no-json` flag present → human mode
3. Neither → `process.stdout.isTTY ? "human" : "json"`

The `--json` flag is a global flag on the top-level `citty` command,
inherited by all subcommands.

```ts
function getOutputMode(args: { json?: boolean }): "json" | "human" {
  if (args.json === true) return "json";
  if (args.json === false) return "human";
  return process.stdout.isTTY ? "human" : "json";
}
```

## Command Wrapper Pattern

Each command's `run` function returns a typed result object. A `withOutput`
wrapper handles formatting:

```ts
type CommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string; hint?: string };

async function withOutput<T>(
  outputMode: "json" | "human",
  fn: () => Promise<CommandResult<T>>,
  humanRender: (result: CommandResult<T>) => void
): Promise<void> {
  const result = await fn();
  if (outputMode === "json") {
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exit(1);
  } else {
    humanRender(result);
    if (!result.ok) process.exit(1);
  }
}
```

- `fn` does the work, returns structured data, never prints.
- `humanRender` contains all `log.success()` / `log.error()` calls — this
  is where existing output code moves.
- JSON mode writes exactly one JSON line to stdout.
- Exit codes: 0 success, 1 failure.
- Error codes are short strings (`"auth_failed"`, `"build_failed"`, etc.).

## Per-Command JSON Shapes

### `aai init`

```json
{ "ok": true, "data": { "dir": "/path/to/my-agent", "template": "simple", "deployed": true, "slug": "my-agent-xyz", "url": "https://aai-agent.fly.dev/my-agent-xyz" } }
```

When `--skipDeploy` is set or deploy is skipped, `deployed` is `false` and
`slug`/`url` are omitted.

Error codes: `"dir_exists"` (hint: use `--force`), `"deploy_failed"`

### `aai build`

```json
{ "ok": true, "data": { "manifest": { "name": "My Agent", "tools": ["search", "lookup"] }, "workerBytes": 14200 } }
```

Error codes: `"build_failed"`, `"validation_failed"`, `"test_failed"`

### `aai deploy`

```json
{ "ok": true, "data": { "slug": "my-agent-xyz", "url": "https://aai-agent.fly.dev/my-agent-xyz" } }
```

Error codes: `"auth_failed"`, `"build_failed"`, `"network_error"`,
`"bundle_too_large"`

### `aai delete`

```json
{ "ok": true, "data": { "slug": "my-agent-xyz" } }
```

Error codes: `"auth_failed"`, `"not_found"`, `"network_error"`

### `aai secret put`

```json
{ "ok": true, "data": { "name": "OPENAI_API_KEY" } }
```

In non-TTY mode, reads value from stdin. Error codes: `"auth_failed"`,
`"no_input"` (hint: pipe secret value to stdin)

### `aai secret delete`

```json
{ "ok": true, "data": { "name": "OPENAI_API_KEY" } }
```

### `aai secret list`

```json
{ "ok": true, "data": { "secrets": ["OPENAI_API_KEY", "CUSTOM_TOKEN"] } }
```

### `aai dev`

```json
{ "ok": true, "data": { "url": "http://localhost:3000" } }
```

Emitted once when server is ready. Process stays alive until killed.

### `aai test`

```json
{ "ok": true, "data": { "passed": true } }
```

Error code: `"test_failed"`

## Non-Interactive Behaviors

Three places currently block on interactive prompts:

### `aai init` prompts

- `--yes` flag already uses defaults (`"my-voice-agent"`, `"simple"`).
- **New**: in non-TTY mode, auto-imply `--yes`. Claude Code never needs to
  remember the flag.
- Explicit flags still override: `aai init my-agent -t web-researcher`.

### `aai secret put` password prompt

- **Current**: always uses `@clack/prompts.password()`, no bypass.
- **New**: in non-TTY mode, read value from stdin.
  `echo "sk-123" | aai secret put OPENAI_API_KEY`
- If stdin is empty/EOF and non-TTY, return error
  `{ "code": "no_input", "hint": "Pipe secret value to stdin" }`.
- TTY mode keeps the interactive password prompt unchanged.

### API key prompt (`_config.ts`)

- Already handled: `ASSEMBLYAI_API_KEY` env var skips the prompt.
- Already handled: `ci-info` throws instead of prompting in non-TTY.
- **New**: the thrown error becomes a structured JSON error:
  `{ "code": "auth_failed", "hint": "Set ASSEMBLYAI_API_KEY env var" }`.

## Suppressing Human Output in JSON Mode

### Silent `log` replacement

When JSON mode is detected, replace the `log` export from `_ui.ts` with
no-ops before any command runs:

```ts
// _ui.ts
export let log = clackLog;

export function silenceOutput() {
  log = {
    info: noop, success: noop, error: noop,
    warn: noop, step: noop, message: noop,
  };
}
```

Called once in `cli.ts` before dispatching to the subcommand.

### Spinners

Suppressed entirely in JSON mode. No stderr progress signals — Claude Code
doesn't need them.

### Stdout contract in JSON mode

- Exactly one JSON line on success (exit 0).
- Exactly one JSON line on failure (exit 1).
- Nothing else on stdout.

## Files Changed

| File | Change |
|------|--------|
| `cli.ts` | Add global `--json` flag, detect output mode, apply `withOutput` wrapper |
| `_ui.ts` | Add `silenceOutput()`, export mutable `log` |
| `init.ts` | Return `InitResult`, auto-imply `--yes` in non-TTY |
| `dev.ts` | Return `DevResult` (emitted when server ready) |
| `test.ts` | Return `TestResult` |
| `build.ts` | Return `BuildResult` |
| `deploy.ts` | Return `DeployResult` |
| `delete.ts` | Return `DeleteResult` |
| `secret.ts` | Return result types, add stdin reading for `put` in non-TTY |
| `_config.ts` | Structured error for missing API key |

## Files Not Changed

- No new commands.
- No changes to SDK, UI package, server, or templates.
- No changes to build/bundle pipeline.
- No changes to wire protocol or API endpoints.
- Human-mode TTY experience identical to today.
- `.aai/project.json` format unchanged.

## Testing Strategy

- Each command gets a test asserting its JSON output shape (assert on the
  returned `CommandResult` object directly).
- Non-TTY stdin test for `secret put`.
- Integration test: pipe commands together to verify clean JSON stdout
  (no ANSI codes, no log lines, valid JSON).
