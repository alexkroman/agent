# CLI Machine Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `aai` CLI command emit structured JSON in non-interactive contexts so Claude Code can reliably build and deploy voice agents.

**Architecture:** Add a `withOutput` command wrapper and `getOutputMode` detection to the existing `citty` CLI. Each command's `run` function returns a typed result object; the wrapper formats it as JSON (non-TTY) or human-readable (`@clack/prompts`, TTY). A new `_output.ts` module owns the types, wrapper, and mode detection. The `_ui.ts` module gains a `silenceOutput()` function to suppress all `@clack/prompts` logging in JSON mode.

**Tech Stack:** TypeScript, citty, @clack/prompts, vitest

**Spec:** `docs/superpowers/specs/2026-04-09-cli-machine-output-design.md`

---

### Task 1: Create `_output.ts` — types, mode detection, and wrapper

**Files:**
- Create: `packages/aai-cli/_output.ts`
- Create: `packages/aai-cli/_output.test.ts`

- [ ] **Step 1: Write the failing test for `getOutputMode`**

Create `packages/aai-cli/_output.test.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it } from "vitest";
import { getOutputMode } from "./_output.ts";

describe("getOutputMode", () => {
  it("returns json when --json flag is true", () => {
    expect(getOutputMode({ json: true }, true)).toBe("json");
  });

  it("returns human when --json flag is false (--no-json)", () => {
    expect(getOutputMode({ json: false }, false)).toBe("human");
  });

  it("returns json when no flag and non-TTY", () => {
    expect(getOutputMode({}, false)).toBe("json");
  });

  it("returns human when no flag and TTY", () => {
    expect(getOutputMode({}, true)).toBe("human");
  });

  it("--json overrides TTY detection", () => {
    expect(getOutputMode({ json: true }, true)).toBe("json");
  });

  it("--no-json overrides non-TTY detection", () => {
    expect(getOutputMode({ json: false }, false)).toBe("human");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-cli/_output.test.ts --project aai-cli`
Expected: FAIL — `_output.ts` does not exist

- [ ] **Step 3: Implement `_output.ts`**

Create `packages/aai-cli/_output.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

/**
 * Structured output support for CLI commands.
 *
 * In JSON mode (non-TTY or --json), commands emit exactly one JSON line to
 * stdout. In human mode (TTY, default), commands use @clack/prompts as before.
 */

export type OutputMode = "json" | "human";

export type CommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string; hint?: string };

/**
 * Determine output mode from CLI flags and TTY state.
 *
 * Priority: --json flag > --no-json flag > TTY auto-detection.
 */
export function getOutputMode(
  args: { json?: boolean | undefined },
  isTTY = !!process.stdout.isTTY,
): OutputMode {
  if (args.json === true) return "json";
  if (args.json === false) return "human";
  return isTTY ? "human" : "json";
}

/**
 * Wrap a command function to handle output formatting.
 *
 * - `fn` does the work and returns a `CommandResult<T>`. It must not print.
 * - `humanRender` formats the result for human-readable TTY output.
 * - In JSON mode, writes exactly one JSON line to stdout.
 */
export async function withOutput<T>(
  mode: OutputMode,
  fn: () => Promise<CommandResult<T>>,
  humanRender: (result: CommandResult<T>) => void,
): Promise<void> {
  const result = await fn();
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exit(1);
  } else {
    humanRender(result);
    if (!result.ok) process.exit(1);
  }
}

/** Create an ok result. */
export function ok<T>(data: T): CommandResult<T> {
  return { ok: true, data };
}

/** Create an error result. */
export function fail<T>(code: string, error: string, hint?: string): CommandResult<T> {
  return hint ? { ok: false, error, code, hint } : { ok: false, error, code };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-cli/_output.test.ts --project aai-cli`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing test for `withOutput`**

Add to `packages/aai-cli/_output.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fail, getOutputMode, ok, withOutput } from "./_output.ts";

// ... existing getOutputMode tests ...

describe("withOutput", () => {
  it("writes JSON to stdout in json mode", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const humanRender = vi.fn();

    await withOutput("json", async () => ok({ slug: "test-abc" }), humanRender);

    expect(writeSpy).toHaveBeenCalledWith('{"ok":true,"data":{"slug":"test-abc"}}\n');
    expect(humanRender).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("calls humanRender in human mode", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const humanRender = vi.fn();
    const result = ok({ slug: "test-abc" });

    await withOutput("human", async () => result, humanRender);

    expect(humanRender).toHaveBeenCalledWith(result);
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("writes JSON error and exits 1 in json mode on failure", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const humanRender = vi.fn();

    await withOutput(
      "json",
      async () => fail("not_found", "Agent not found"),
      humanRender,
    );

    expect(writeSpy).toHaveBeenCalledWith(
      '{"ok":false,"error":"Agent not found","code":"not_found"}\n',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("ok / fail helpers", () => {
  it("ok wraps data", () => {
    expect(ok({ x: 1 })).toEqual({ ok: true, data: { x: 1 } });
  });

  it("fail creates error without hint", () => {
    expect(fail("auth_failed", "No key")).toEqual({
      ok: false, error: "No key", code: "auth_failed",
    });
  });

  it("fail creates error with hint", () => {
    expect(fail("auth_failed", "No key", "Set env var")).toEqual({
      ok: false, error: "No key", code: "auth_failed", hint: "Set env var",
    });
  });
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-cli/_output.test.ts --project aai-cli`
Expected: PASS (all tests)

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/_output.ts packages/aai-cli/_output.test.ts
git commit -m "feat(aai-cli): add _output.ts with CommandResult, getOutputMode, withOutput"
```

---

### Task 2: Add `silenceOutput()` to `_ui.ts`

**Files:**
- Modify: `packages/aai-cli/_ui.ts`
- Modify: `packages/aai-cli/_ui.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/aai-cli/_ui.test.ts` (read the existing file first to understand current tests):

```ts
import { describe, expect, it } from "vitest";
import { getLog, silenceOutput } from "./_ui.ts";

describe("silenceOutput", () => {
  it("replaces log methods with no-ops", () => {
    silenceOutput();
    const log = getLog();
    // Should not throw — just no-ops
    expect(() => log.info("test")).not.toThrow();
    expect(() => log.success("test")).not.toThrow();
    expect(() => log.error("test")).not.toThrow();
    expect(() => log.warn("test")).not.toThrow();
    expect(() => log.step("test")).not.toThrow();
    expect(() => log.message("test")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-cli/_ui.test.ts --project aai-cli`
Expected: FAIL — `silenceOutput` and `getLog` not exported

- [ ] **Step 3: Implement `silenceOutput` in `_ui.ts`**

Replace the contents of `packages/aai-cli/_ui.ts`. Uses a `Proxy` so that
existing `import { log }` bindings automatically delegate through the proxy
even after `silenceOutput()` swaps the delegate:

```ts
// Copyright 2025 the AAI authors. MIT license.

import { log as clackLog } from "@clack/prompts";
import { colorize } from "consola/utils";

type Log = typeof clackLog;

const noop = () => {};
let _delegate: Log = clackLog;

const logHandler: ProxyHandler<Log> = {
  get(_target, prop, receiver) {
    return Reflect.get(_delegate, prop, receiver);
  },
};

/** Log instance that delegates to clack (human mode) or no-ops (JSON mode). */
export const log: Log = new Proxy(clackLog, logHandler);

/** Replace all log methods with no-ops. Call once in JSON mode. */
export function silenceOutput(): void {
  _delegate = {
    info: noop,
    success: noop,
    error: noop,
    warn: noop,
    step: noop,
    message: noop,
  } as unknown as Log;
}

/** Format a URL for display. */
export function fmtUrl(url: string): string {
  return colorize("cyanBright", url);
}

/** Parse and validate a port string. Returns the numeric port or throws. */
export function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${raw}. Must be a number between 0 and 65535.`);
  }
  return port;
}
```

- [ ] **Step 4: Update the test to match the Proxy-based API**

The test should now use `log` directly (no `getLog()`):

```ts
import { describe, expect, it } from "vitest";
import { log, silenceOutput } from "./_ui.ts";

describe("silenceOutput", () => {
  it("replaces log methods with no-ops after silenceOutput()", () => {
    silenceOutput();
    // Should not throw — all methods are now no-ops
    expect(() => log.info("test")).not.toThrow();
    expect(() => log.success("test")).not.toThrow();
    expect(() => log.error("test")).not.toThrow();
    expect(() => log.warn("test")).not.toThrow();
    expect(() => log.step("test")).not.toThrow();
    expect(() => log.message("test")).not.toThrow();
  });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-cli/_ui.test.ts --project aai-cli`
Expected: PASS

- [ ] **Step 6: Run all existing CLI tests to verify no regressions**

Run: `pnpm vitest run --project aai-cli`
Expected: All existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/_ui.ts packages/aai-cli/_ui.test.ts
git commit -m "feat(aai-cli): add silenceOutput() to _ui.ts via Proxy delegate"
```

---

### Task 3: Add `--json` global flag to `cli.ts` and wire up output mode + silence

**Files:**
- Modify: `packages/aai-cli/cli.ts`

- [ ] **Step 1: Add `json` to `sharedArgs` and pass output mode to `handleErrors`**

In `packages/aai-cli/cli.ts`, update the `sharedArgs` definition (line 12):

```ts
const sharedArgs = {
  port: { type: "string", alias: "p", description: "Port to listen on", default: "3000" },
  server: { type: "string", alias: "s", description: "Platform server URL" },
  yes: { type: "boolean", alias: "y", description: "Accept defaults (no prompts)" },
  json: { type: "boolean", description: "Output JSON (auto-detected in non-TTY)" },
} as const;
```

- [ ] **Step 2: Update imports to include `_output.ts` and `silenceOutput`**

Add to the top of `cli.ts`:

```ts
import { type OutputMode, fail, getOutputMode } from "./_output.ts";
import { silenceOutput } from "./_ui.ts";
```

- [ ] **Step 3: Update `handleErrors` to support JSON mode**

Replace the `handleErrors` function (lines 52-61):

```ts
/** Catch command errors and format output based on mode. */
async function handleErrors(mode: OutputMode, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err: unknown) {
    if (mode === "json") {
      const result = fail("command_failed", errorMessage(err));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(1);
    }
    const { log } = await import("./_ui.ts");
    log.error(errorMessage(err));
    process.exit(1);
  }
}
```

- [ ] **Step 4: Add a helper to resolve output mode and silence output**

Add after `handleErrors`:

```ts
/** Resolve output mode from args, silence output if JSON, and auto-imply --yes in non-TTY. */
function resolveMode(args: { json?: boolean; yes?: boolean }): OutputMode {
  const mode = getOutputMode(args);
  if (mode === "json") {
    silenceOutput();
    args.yes = true; // auto-imply --yes in JSON/non-TTY mode
  }
  return mode;
}
```

- [ ] **Step 5: Wire up each command to use `resolveMode` and pass mode to `handleErrors`**

Update each command's `run` function. Example for `init`:

```ts
const init = defineCommand({
  meta: { name: "init", description: "Scaffold a new agent project" },
  args: {
    dir: { type: "positional", description: "Project directory", required: false },
    template: { type: "string", alias: "t", description: "Template to use" },
    force: { type: "boolean", alias: "f", description: "Overwrite existing files" },
    server: sharedArgs.server,
    yes: sharedArgs.yes,
    json: sharedArgs.json,
    skipApi: { type: "boolean", description: "Skip API key check" },
    skipDeploy: { type: "boolean", description: "Skip deploy after scaffolding" },
  },
  async run({ args }) {
    const mode = resolveMode(args);
    await handleErrors(mode, async () => {
      const { runInitCommand } = await import("./init.ts");
      await runInitCommand({
        dir: args.dir,
        template: args.template,
        force: args.force,
        yes: args.yes,
        skipApi: args.skipApi,
        skipDeploy: args.skipDeploy,
        server: args.server,
      });
    });
  },
});
```

Apply the same pattern to all commands: add `json: sharedArgs.json` to args, call `resolveMode(args)`, pass `mode` to `handleErrors`. For commands that don't have `yes` in args (like `test`, `delete`), just use `getOutputMode(args)` + `silenceOutput()` without the `yes` implication.

Update each command similarly:

**`dev`**: Add `json: sharedArgs.json`, use `resolveMode(args)`
**`test`**: Add `json: sharedArgs.json`, use `const mode = getOutputMode(args); if (mode === "json") silenceOutput();`
**`build`**: Add `json: sharedArgs.json`, use `resolveMode(args)`
**`deploy`**: Add `json: sharedArgs.json`, use `resolveMode(args)`
**`delete` (`del`)**: Add `json: sharedArgs.json`, use `const mode = getOutputMode(args); if (mode === "json") silenceOutput();`
**`secretPut`**: Add `json: sharedArgs.json`, use same pattern
**`secretDelete`**: Add `json: sharedArgs.json`, use same pattern
**`secretList`**: Add `json: sharedArgs.json`, use same pattern

- [ ] **Step 6: Run all CLI tests to verify no regressions**

Run: `pnpm vitest run --project aai-cli`
Expected: All tests still pass (behavior unchanged — no command returns JSON yet, we've only added plumbing)

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/cli.ts
git commit -m "feat(aai-cli): add --json flag, output mode detection, and silence plumbing"
```

---

### Task 4: Migrate `delete` command to structured output

The simplest command — good starting point.

**Files:**
- Modify: `packages/aai-cli/delete.ts`
- Modify: `packages/aai-cli/cli.ts` (update delete command's `run`)

- [ ] **Step 1: Write the failing test**

Create or add to `packages/aai-cli/delete.test.ts` (read existing file first):

```ts
import { describe, expect, it, vi } from "vitest";

describe("runDeleteCommand (structured)", () => {
  it("returns ok result with slug on success", async () => {
    vi.doMock("./_agent.ts", () => ({
      getServerInfo: async () => ({
        serverUrl: "https://example.com",
        slug: "my-agent",
        apiKey: "key123",
      }),
    }));
    vi.doMock("./_delete.ts", () => ({
      runDelete: vi.fn().mockResolvedValue(undefined),
    }));

    const { executeDelete } = await import("./delete.ts");
    const result = await executeDelete({ cwd: "/tmp/test" });

    expect(result).toEqual({ ok: true, data: { slug: "my-agent" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-cli/delete.test.ts --project aai-cli`
Expected: FAIL — `executeDelete` not exported

- [ ] **Step 3: Refactor `delete.ts` to return `CommandResult`**

Replace `packages/aai-cli/delete.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

import { type CommandResult, ok } from "./_output.ts";
import { getServerInfo } from "./_agent.ts";
import { runDelete } from "./_delete.ts";
import { log } from "./_ui.ts";

type DeleteData = { slug: string };

/** Execute delete and return structured result. */
export async function executeDelete(opts: {
  cwd: string;
  server?: string;
}): Promise<CommandResult<DeleteData>> {
  const { cwd } = opts;
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, opts.server);

  log.step(`Deleting ${slug}`);
  await runDelete({ url: serverUrl, slug, apiKey });
  log.success(`Deleted ${serverUrl}/${slug}`);

  return ok({ slug });
}

/** Human-mode entry point (called from cli.ts in human mode). */
export async function runDeleteCommand(opts: { cwd: string; server?: string }): Promise<void> {
  const result = await executeDelete(opts);
  if (!result.ok) {
    log.error(result.error);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Update `cli.ts` delete command to use `withOutput`**

In `cli.ts`, update the delete command's `run`:

```ts
const del = defineCommand({
  meta: { name: "delete", description: "Remove a deployed agent" },
  args: {
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    const mode = getOutputMode(args);
    if (mode === "json") silenceOutput();
    await handleErrors(mode, async () => {
      const cwd = await setup();
      const { executeDelete } = await import("./delete.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(mode, () => executeDelete({ cwd, ...(args.server ? { server: args.server } : {}) }), () => {});
    });
  },
});
```

Since `executeDelete` already calls `log.step` and `log.success` (which are silenced in JSON mode), the `humanRender` callback is a no-op — the human output happens inside the function. In JSON mode, `log.*` calls are silenced and `withOutput` emits the JSON.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/aai-cli/delete.test.ts --project aai-cli`
Expected: PASS

- [ ] **Step 6: Run all CLI tests**

Run: `pnpm vitest run --project aai-cli`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/delete.ts packages/aai-cli/delete.test.ts packages/aai-cli/cli.ts
git commit -m "feat(aai-cli): migrate delete command to structured output"
```

---

### Task 5: Migrate `secret` commands to structured output

**Files:**
- Modify: `packages/aai-cli/secret.ts`
- Modify: `packages/aai-cli/cli.ts`

- [ ] **Step 1: Write failing tests for all three secret subcommands**

Add to or create `packages/aai-cli/secret.test.ts` (read existing tests first):

```ts
import { describe, expect, it, vi } from "vitest";

const mockServerInfo = {
  serverUrl: "https://example.com",
  slug: "my-agent",
  apiKey: "key123",
};

describe("executeSecretPut", () => {
  it("reads value from stdin in non-TTY mode and returns ok", async () => {
    vi.doMock("./_agent.ts", () => ({ getServerInfo: async () => mockServerInfo }));
    vi.doMock("./_api-client.ts", () => ({
      apiRequestOrThrow: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    }));

    const { executeSecretPut } = await import("./secret.ts");
    const result = await executeSecretPut("/tmp", "MY_SECRET", "test-value", undefined);

    expect(result).toEqual({ ok: true, data: { name: "MY_SECRET" } });
  });
});

describe("executeSecretDelete", () => {
  it("returns ok with name on success", async () => {
    vi.doMock("./_agent.ts", () => ({ getServerInfo: async () => mockServerInfo }));
    vi.doMock("./_api-client.ts", () => ({
      apiRequestOrThrow: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    }));

    const { executeSecretDelete } = await import("./secret.ts");
    const result = await executeSecretDelete("/tmp", "MY_SECRET", undefined);

    expect(result).toEqual({ ok: true, data: { name: "MY_SECRET" } });
  });
});

describe("executeSecretList", () => {
  it("returns ok with secret names", async () => {
    vi.doMock("./_agent.ts", () => ({ getServerInfo: async () => mockServerInfo }));
    vi.doMock("./_api-client.ts", () => ({
      apiRequestOrThrow: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ vars: ["KEY_A", "KEY_B"] }), { status: 200 }),
      ),
    }));

    const { executeSecretList } = await import("./secret.ts");
    const result = await executeSecretList("/tmp", undefined);

    expect(result).toEqual({ ok: true, data: { secrets: ["KEY_A", "KEY_B"] } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/aai-cli/secret.test.ts --project aai-cli`
Expected: FAIL — `executeSecret*` not exported

- [ ] **Step 3: Refactor `secret.ts` to return `CommandResult` and support stdin**

Replace `packages/aai-cli/secret.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

import * as p from "@clack/prompts";
import { getServerInfo } from "./_agent.ts";
import { apiRequestOrThrow } from "./_api-client.ts";
import { type CommandResult, fail, ok } from "./_output.ts";
import { log } from "./_ui.ts";

async function secretRequest(
  cwd: string,
  pathSuffix: string,
  init?: RequestInit,
  server?: string,
): Promise<{ resp: Response; slug: string }> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, server);
  const resp = await apiRequestOrThrow(`${serverUrl}/${slug}/secret${pathSuffix}`, {
    ...init,
    apiKey,
    action: "secret",
  });
  return { resp, slug };
}

/** Read secret value from stdin (for non-TTY / piped input). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

type SecretPutData = { name: string };
type SecretDeleteData = { name: string };
type SecretListData = { secrets: string[] };

/**
 * Execute secret put. If `value` is provided, use it directly (non-TTY path).
 * If not provided, prompt interactively (TTY path).
 */
export async function executeSecretPut(
  cwd: string,
  name: string,
  value: string | undefined,
  server: string | undefined,
): Promise<CommandResult<SecretPutData>> {
  let secretValue = value;

  if (!secretValue) {
    // TTY path — interactive prompt
    const result = await p.password({ message: `Enter value for ${name}` });
    if (p.isCancel(result)) process.exit(0);
    if (!result) return fail("no_input", "No value provided");
    secretValue = result;
  }

  const { slug } = await secretRequest(
    cwd,
    "",
    { method: "PUT", body: JSON.stringify({ [name]: secretValue }) },
    server,
  );
  log.success(`Set ${name} for ${slug}`);
  return ok({ name });
}

export async function executeSecretDelete(
  cwd: string,
  name: string,
  server: string | undefined,
): Promise<CommandResult<SecretDeleteData>> {
  const { slug } = await secretRequest(cwd, `/${name}`, { method: "DELETE" }, server);
  log.success(`Deleted ${name} from ${slug}`);
  return ok({ name });
}

export async function executeSecretList(
  cwd: string,
  server: string | undefined,
): Promise<CommandResult<SecretListData>> {
  const { resp } = await secretRequest(cwd, "", undefined, server);
  const { vars } = (await resp.json()) as { vars: string[] };
  if (vars.length === 0) {
    log.info("No secrets set. Use `aai secret put <name>` to add one.");
  } else {
    log.message(`${vars.length} secret${vars.length === 1 ? "" : "s"}:`);
    for (const v of vars) {
      log.message(`  ${v}`);
    }
  }
  return ok({ secrets: vars });
}

// Legacy exports for backward compat with cli.ts (human mode)
export const runSecretPut = async (cwd: string, name: string, server?: string) => {
  await executeSecretPut(cwd, name, undefined, server);
};
export const runSecretDelete = async (cwd: string, name: string, server?: string) => {
  await executeSecretDelete(cwd, name, server);
};
export const runSecretList = async (cwd: string, server?: string) => {
  await executeSecretList(cwd, server);
};
```

- [ ] **Step 4: Update `cli.ts` secret commands to support stdin in JSON mode**

Update `secretPut` in `cli.ts`:

```ts
const secretPut = defineCommand({
  meta: { name: "put", description: "Create or update a secret" },
  args: {
    name: { type: "positional", description: "Secret name", required: true },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    const mode = getOutputMode(args);
    if (mode === "json") silenceOutput();
    await handleErrors(mode, async () => {
      const cwd = await setup(undefined, { apiKey: true });
      const { executeSecretPut, readStdin } = await import("./secret.ts");
      const { withOutput } = await import("./_output.ts");

      // In JSON/non-TTY mode, read value from stdin
      let value: string | undefined;
      if (mode === "json") {
        const { readStdin } = await import("./secret.ts");
        value = await readStdin();
        if (!value) {
          const { fail: failResult } = await import("./_output.ts");
          process.stdout.write(`${JSON.stringify(failResult("no_input", "No value provided", "Pipe secret value to stdin"))}\n`);
          process.exit(1);
        }
      }

      await withOutput(
        mode,
        () => executeSecretPut(cwd, args.name, value, args.server),
        () => {},
      );
    });
  },
});
```

Actually, this is getting convoluted. Simpler approach — just handle stdin inside `executeSecretPut` based on TTY detection:

Update `cli.ts` secretPut to be simpler:

```ts
const secretPut = defineCommand({
  meta: { name: "put", description: "Create or update a secret" },
  args: {
    name: { type: "positional", description: "Secret name", required: true },
    server: sharedArgs.server,
    json: sharedArgs.json,
  },
  async run({ args }) {
    const mode = getOutputMode(args);
    if (mode === "json") silenceOutput();
    await handleErrors(mode, async () => {
      const cwd = await setup(undefined, { apiKey: true });
      const { executeSecretPut, readStdin } = await import("./secret.ts");
      const { withOutput } = await import("./_output.ts");

      const value = mode === "json" ? await readStdin() : undefined;
      await withOutput(mode, () => executeSecretPut(cwd, args.name, value, args.server), () => {});
    });
  },
});
```

And export `readStdin` from `secret.ts`.

Apply the same `withOutput` pattern to `secretDelete` and `secretList` in `cli.ts`.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/aai-cli/secret.test.ts --project aai-cli`
Expected: PASS

- [ ] **Step 6: Run all CLI tests**

Run: `pnpm vitest run --project aai-cli`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/secret.ts packages/aai-cli/secret.test.ts packages/aai-cli/cli.ts
git commit -m "feat(aai-cli): migrate secret commands to structured output, add stdin support for put"
```

---

### Task 6: Migrate `deploy` command to structured output

**Files:**
- Modify: `packages/aai-cli/deploy.ts`
- Modify or create: `packages/aai-cli/deploy.test.ts`
- Modify: `packages/aai-cli/cli.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/aai-cli/deploy.test.ts` (read existing file first):

```ts
import { describe, expect, it, vi } from "vitest";

describe("executeDeploy", () => {
  it("returns ok with slug and url on success", async () => {
    vi.doMock("./_agent.ts", () => ({
      resolveServerUrl: () => "https://example.com",
    }));
    vi.doMock("./_bundler.ts", () => ({
      buildAgentBundle: vi.fn().mockResolvedValue({
        manifest: { name: "Test", tools: {} },
        manifestJson: "{}",
        toolBundles: {},
        hookBundles: {},
      }),
    }));
    vi.doMock("./_config.ts", () => ({
      getApiKey: async () => "key123",
      readProjectConfig: async () => ({ slug: "my-agent", serverUrl: "https://example.com" }),
      writeProjectConfig: vi.fn(),
    }));
    vi.doMock("./_deploy.ts", () => ({
      runDeploy: vi.fn().mockResolvedValue({ slug: "my-agent" }),
    }));

    const { executeDeploy } = await import("./deploy.ts");
    const result = await executeDeploy({ cwd: "/tmp/test" });

    expect(result).toEqual({
      ok: true,
      data: { slug: "my-agent", url: "https://example.com/my-agent" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-cli/deploy.test.ts --project aai-cli`
Expected: FAIL — `executeDeploy` not exported

- [ ] **Step 3: Refactor `deploy.ts`**

Replace `packages/aai-cli/deploy.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

import { resolveServerUrl } from "./_agent.ts";
import { buildAgentBundle } from "./_bundler.ts";
import { getApiKey, readProjectConfig, writeProjectConfig } from "./_config.ts";
import { runDeploy } from "./_deploy.ts";
import { type CommandResult, ok } from "./_output.ts";
import { fmtUrl, log } from "./_ui.ts";

type DeployData = { slug: string; url: string };

export async function executeDeploy(opts: {
  cwd: string;
  server?: string;
}): Promise<CommandResult<DeployData>> {
  const { cwd } = opts;
  const apiKey = await getApiKey();
  const projectConfig = await readProjectConfig(cwd);
  const serverUrl = resolveServerUrl(opts.server, projectConfig?.serverUrl);
  const bundle = await buildAgentBundle(cwd);
  const slug = projectConfig?.slug;

  log.step(`Deploying${slug ? ` ${slug}` : ""}…`);
  const deployed = await runDeploy({
    url: serverUrl,
    bundle,
    env: { ASSEMBLYAI_API_KEY: apiKey },
    ...(slug ? { slug } : {}),
    apiKey,
  });

  await writeProjectConfig(cwd, { slug: deployed.slug, serverUrl });

  const agentUrl = `${serverUrl}/${deployed.slug}`;
  log.success(`Deployed ${fmtUrl(agentUrl)}`);

  return ok({ slug: deployed.slug, url: agentUrl });
}

export async function runDeployCommand(opts: { cwd: string; server?: string }): Promise<void> {
  await executeDeploy(opts);
}
```

- [ ] **Step 4: Update `cli.ts` deploy command**

```ts
const deploy = defineCommand({
  meta: { name: "deploy", description: "Bundle and deploy to production" },
  args: {
    server: sharedArgs.server,
    yes: sharedArgs.yes,
    json: sharedArgs.json,
  },
  async run({ args }) {
    const mode = resolveMode(args);
    await handleErrors(mode, async () => {
      const cwd = await setup(args, { agent: true });
      const { executeDeploy } = await import("./deploy.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(mode, () => executeDeploy({ cwd, ...(args.server ? { server: args.server } : {}) }), () => {});
    });
  },
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/aai-cli/deploy.test.ts --project aai-cli`
Expected: PASS

- [ ] **Step 6: Run all CLI tests**

Run: `pnpm vitest run --project aai-cli`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/deploy.ts packages/aai-cli/deploy.test.ts packages/aai-cli/cli.ts
git commit -m "feat(aai-cli): migrate deploy command to structured output"
```

---

### Task 7: Migrate `build` command to structured output

**Files:**
- Modify: `packages/aai-cli/_bundler.ts` (the `runBuildCommand` function)
- Modify: `packages/aai-cli/cli.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/aai-cli/_build.test.ts` (read existing file first):

```ts
import { describe, expect, it, vi } from "vitest";

describe("executeBuild", () => {
  it("returns ok with manifest info on success", async () => {
    const mockManifest = { name: "Test Agent", tools: { search: {} } };
    vi.doMock("./_scanner.ts", () => ({
      scanAgentDirectory: vi.fn().mockResolvedValue(mockManifest),
    }));
    vi.doMock("./_ui.ts", () => ({
      log: { step: vi.fn(), success: vi.fn() },
    }));

    const { executeBuild } = await import("./_bundler.ts");
    const result = await executeBuild("/tmp/test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.manifest.name).toBe("Test Agent");
      expect(result.data.manifest.tools).toEqual(["search"]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-cli/_build.test.ts --project aai-cli`
Expected: FAIL — `executeBuild` not exported

- [ ] **Step 3: Add `executeBuild` to `_bundler.ts`**

Add to the end of `packages/aai-cli/_bundler.ts`, replacing `runBuildCommand`:

```ts
import { type CommandResult, ok } from "./_output.ts";

type BuildData = {
  manifest: { name: string; tools: string[] };
  workerBytes: number;
};

export async function executeBuild(cwd: string): Promise<CommandResult<BuildData>> {
  const { log } = await import("./_ui.ts");
  const bundle = await buildAgentBundle(cwd);
  await buildClient(cwd);
  log.success("Build complete");

  const toolNames = Object.keys(bundle.manifest.tools);
  const totalBytes = Object.values(bundle.toolBundles).reduce((sum, code) => sum + code.length, 0)
    + Object.values(bundle.hookBundles).reduce((sum, code) => sum + code.length, 0);

  return ok({
    manifest: { name: bundle.manifest.name, tools: toolNames },
    workerBytes: totalBytes,
  });
}

export async function runBuildCommand(cwd: string): Promise<void> {
  await executeBuild(cwd);
}
```

- [ ] **Step 4: Update `cli.ts` build command**

```ts
const build = defineCommand({
  meta: { name: "build", description: "Bundle agent without deploying" },
  args: {
    server: sharedArgs.server,
    yes: sharedArgs.yes,
    json: sharedArgs.json,
    skipTests: { type: "boolean", description: "Skip running tests before build" },
  },
  async run({ args }) {
    const mode = resolveMode(args);
    await handleErrors(mode, async () => {
      const cwd = await setup(args, { agent: true });
      if (!args.skipTests) {
        const { runVitest } = await import("./test.ts");
        runVitest(cwd);
      }
      const { executeBuild } = await import("./_bundler.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(mode, () => executeBuild(cwd), () => {});
    });
  },
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/aai-cli/_build.test.ts --project aai-cli`
Expected: PASS

- [ ] **Step 6: Run all CLI tests**

Run: `pnpm vitest run --project aai-cli`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/_bundler.ts packages/aai-cli/_build.test.ts packages/aai-cli/cli.ts
git commit -m "feat(aai-cli): migrate build command to structured output"
```

---

### Task 8: Migrate `test` command to structured output

**Files:**
- Modify: `packages/aai-cli/test.ts`
- Modify: `packages/aai-cli/cli.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/aai-cli/test.test.ts` (read existing file first):

```ts
import { describe, expect, it, vi } from "vitest";

describe("executeTest", () => {
  it("returns ok with passed=true when tests pass", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(), // no throw = tests pass
    }));
    vi.doMock("node:fs", () => ({
      existsSync: (p: string) => p.endsWith("agent.test.ts"),
    }));

    const { executeTest } = await import("./test.ts");
    const result = await executeTest("/tmp/test");

    expect(result).toEqual({ ok: true, data: { passed: true } });
  });

  it("returns ok with passed=false and no_tests when no test file", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
    }));

    const { executeTest } = await import("./test.ts");
    const result = await executeTest("/tmp/test");

    expect(result).toEqual({ ok: true, data: { passed: true, skipped: true } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-cli/test.test.ts --project aai-cli`
Expected: FAIL — `executeTest` not exported

- [ ] **Step 3: Refactor `test.ts`**

Replace `packages/aai-cli/test.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { type CommandResult, fail, ok } from "./_output.ts";
import { log } from "./_ui.ts";

type TestData = { passed: boolean; skipped?: boolean };

export function runVitest(cwd: string): boolean {
  let testFile: string | null = null;
  if (existsSync(path.join(cwd, "agent.test.ts"))) testFile = "agent.test.ts";
  else if (existsSync(path.join(cwd, "agent.test.js"))) testFile = "agent.test.js";

  if (!testFile) return false;

  execFileSync("npx", ["vitest", "run", "--root", ".", testFile], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
  });

  return true;
}

export async function executeTest(cwd: string): Promise<CommandResult<TestData>> {
  log.step("Running agent tests");
  try {
    const ran = runVitest(cwd);
    if (!ran) {
      log.info("No test file found. Create agent.test.ts to add tests.");
      return ok({ passed: true, skipped: true });
    }
    log.success("Tests passed");
    return ok({ passed: true });
  } catch {
    return fail("test_failed", "Tests failed");
  }
}

export async function runTestCommand(cwd: string): Promise<void> {
  const result = await executeTest(cwd);
  if (!result.ok) throw new Error(result.error);
}
```

- [ ] **Step 4: Update `cli.ts` test command**

```ts
const test = defineCommand({
  meta: { name: "test", description: "Run agent tests" },
  args: {
    json: sharedArgs.json,
  },
  async run({ args }) {
    const mode = getOutputMode(args);
    if (mode === "json") silenceOutput();
    await handleErrors(mode, async () => {
      const cwd = await setup();
      const { executeTest } = await import("./test.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(mode, () => executeTest(cwd), () => {});
    });
  },
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/aai-cli/test.test.ts --project aai-cli`
Expected: PASS

- [ ] **Step 6: Run all CLI tests**

Run: `pnpm vitest run --project aai-cli`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/test.ts packages/aai-cli/test.test.ts packages/aai-cli/cli.ts
git commit -m "feat(aai-cli): migrate test command to structured output"
```

---

### Task 9: Migrate `dev` command to structured output

**Files:**
- Modify: `packages/aai-cli/dev.ts`
- Modify: `packages/aai-cli/cli.ts`

- [ ] **Step 1: Write the failing test**

Add to a test file for dev (create if needed):

```ts
import { describe, expect, it, vi } from "vitest";

describe("executeDev", () => {
  it("returns ok with url when server starts", async () => {
    vi.doMock("./_dev-server.ts", () => ({
      startDevServer: vi.fn().mockResolvedValue(() => Promise.resolve()),
    }));

    const { executeDev } = await import("./dev.ts");

    // executeDev is long-running, but it returns the result before waiting
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const result = await executeDev({ cwd: "/tmp/test", port: "3000" });

    expect(result).toEqual({ ok: true, data: { url: "http://localhost:3000" } });
    writeSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-cli/dev.test.ts --project aai-cli`
Expected: FAIL — `executeDev` not exported

- [ ] **Step 3: Refactor `dev.ts`**

Replace `packages/aai-cli/dev.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { colorize } from "consola/utils";
import { type CommandResult, ok } from "./_output.ts";
import { fmtUrl, log, parsePort } from "./_ui.ts";

type DevData = { url: string };

/**
 * Start the dev server and return the result.
 * The process stays alive after this returns — caller handles signals.
 */
export async function executeDev(opts: {
  cwd: string;
  port: string;
}): Promise<CommandResult<DevData>> {
  const port = parsePort(opts.port);
  const agentName = path.basename(path.resolve(opts.cwd));
  const { startDevServer } = await import("./_dev-server.ts");
  const cleanup = await startDevServer({ cwd: opts.cwd, port });

  const url = `http://localhost:${port}`;
  log.success(`${colorize("bold", agentName)} running at ${fmtUrl(url)}`);
  log.info("Press Ctrl-C to stop");

  // Graceful shutdown
  const onSignal = () => {
    void cleanup().finally(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return ok({ url });
}

export async function runDevCommand(opts: { cwd: string; port: string }): Promise<void> {
  await executeDev(opts);
}
```

- [ ] **Step 4: Update `cli.ts` dev command**

```ts
const dev = defineCommand({
  meta: { name: "dev", description: "Start a local development server" },
  args: {
    port: sharedArgs.port,
    server: sharedArgs.server,
    yes: sharedArgs.yes,
    json: sharedArgs.json,
  },
  async run({ args }) {
    const mode = resolveMode(args);
    await handleErrors(mode, async () => {
      const cwd = await setup(args, { agent: true, apiKey: true });
      const { executeDev } = await import("./dev.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(mode, () => executeDev({ cwd, port: args.port }), () => {});
    });
  },
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/aai-cli/dev.test.ts --project aai-cli`
Expected: PASS

- [ ] **Step 6: Run all CLI tests**

Run: `pnpm vitest run --project aai-cli`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/dev.ts packages/aai-cli/dev.test.ts packages/aai-cli/cli.ts
git commit -m "feat(aai-cli): migrate dev command to structured output"
```

---

### Task 10: Migrate `init` command to structured output

The most complex command — has interactive prompts, optional deploy, spinners.

**Files:**
- Modify: `packages/aai-cli/init.ts`
- Modify: `packages/aai-cli/cli.ts`
- Modify: `packages/aai-cli/init.test.ts` (read existing tests first)

- [ ] **Step 1: Write the failing test**

Add to `packages/aai-cli/init.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

describe("executeInit", () => {
  it("returns ok with dir and template when skipDeploy", async () => {
    vi.doMock("./_config.ts", () => ({
      ensureApiKeyInEnv: vi.fn(),
    }));
    vi.doMock("./_init.ts", () => ({
      runInit: vi.fn(),
    }));
    vi.doMock("./_agent.ts", () => ({
      getMonorepoRoot: () => null,
      isDevMode: () => false,
      DEFAULT_DEV_SERVER: "http://localhost:8080",
    }));
    vi.doMock("./_utils.ts", () => ({
      fileExists: async () => false,
      resolveCwd: () => "/tmp",
    }));

    const { executeInit } = await import("./init.ts");
    const result = await executeInit({
      dir: "test-agent",
      template: "simple",
      yes: true,
      skipDeploy: true,
      skipApi: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.template).toBe("simple");
      expect(result.data.deployed).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/aai-cli/init.test.ts --project aai-cli`
Expected: FAIL — `executeInit` not exported

- [ ] **Step 3: Refactor `init.ts`**

Add the `executeInit` function and result type. Keep existing functions. Add at the end of the file, modifying `runInitCommand` to delegate:

```ts
import { type CommandResult, ok } from "./_output.ts";

type InitData = {
  dir: string;
  template: string;
  deployed: boolean;
  slug?: string;
  url?: string;
};

export async function executeInit(
  opts: {
    dir?: string | undefined;
    template?: string | undefined;
    force?: boolean | undefined;
    yes?: boolean | undefined;
    skipApi?: boolean | undefined;
    skipDeploy?: boolean | undefined;
    server?: string | undefined;
  },
  extra?: { quiet?: boolean | undefined },
): Promise<CommandResult<InitData>> {
  if (!extra?.quiet) {
    p.intro(colorize("cyanBright", "Create a new voice agent"));
  }

  if (!opts.skipApi) {
    await ensureApiKeyInEnv();
  }

  const dir = opts.dir ?? (await promptProjectName(opts.yes));
  const monorepoRoot = getMonorepoRoot();
  const cwd = resolveTargetDir(dir, monorepoRoot);

  if (!opts.force && (await fileExists(path.join(cwd, "agent.ts")))) {
    throw new Error(
      `agent.ts already exists in this directory. Use ${colorize("cyanBright", "--force")} to overwrite.`,
    );
  }

  const template = opts.template ?? (await promptTemplate(opts.yes));

  const s = p.spinner();
  s.start(`Creating ${dir} from ${template} template`);

  const { runInit } = await import("./_init.ts");
  await runInit({ targetDir: cwd, template });
  s.stop("Project created");

  await installDeps(cwd);

  let deployed = false;
  let slug: string | undefined;
  let url: string | undefined;

  if (!(opts.skipDeploy || extra?.quiet)) {
    const server = resolveDeployServer(opts.server, monorepoRoot);
    const { executeDeploy } = await import("./deploy.ts");
    const deployResult = await executeDeploy({ cwd, ...(server ? { server } : {}) });
    if (deployResult.ok) {
      deployed = true;
      slug = deployResult.data.slug;
      url = deployResult.data.url;
    }
  }

  if (!extra?.quiet) {
    log.success(`Created ${dir}`);
    const cdTarget = monorepoRoot ? `tmp/${dir}` : dir;
    if (monorepoRoot) log.info("Dev mode: project linked to workspace packages");
    log.info(`Next: cd ${cdTarget} && aai dev`);
  }

  const data: InitData = { dir: cwd, template, deployed };
  if (slug) data.slug = slug;
  if (url) data.url = url;
  return ok(data);
}

export async function runInitCommand(
  opts: Parameters<typeof executeInit>[0],
  extra?: Parameters<typeof executeInit>[1],
): Promise<string> {
  const result = await executeInit(opts, extra);
  if (!result.ok) throw new Error(result.error);
  return result.data.dir;
}
```

- [ ] **Step 4: Update `cli.ts` init command**

```ts
const init = defineCommand({
  meta: { name: "init", description: "Scaffold a new agent project" },
  args: {
    dir: { type: "positional", description: "Project directory", required: false },
    template: { type: "string", alias: "t", description: "Template to use" },
    force: { type: "boolean", alias: "f", description: "Overwrite existing files" },
    server: sharedArgs.server,
    yes: sharedArgs.yes,
    json: sharedArgs.json,
    skipApi: { type: "boolean", description: "Skip API key check" },
    skipDeploy: { type: "boolean", description: "Skip deploy after scaffolding" },
  },
  async run({ args }) {
    const mode = resolveMode(args);
    await handleErrors(mode, async () => {
      const { executeInit } = await import("./init.ts");
      const { withOutput } = await import("./_output.ts");
      await withOutput(
        mode,
        () => executeInit({
          dir: args.dir,
          template: args.template,
          force: args.force,
          yes: args.yes,
          skipApi: args.skipApi,
          skipDeploy: args.skipDeploy,
          server: args.server,
        }),
        () => {},
      );
    });
  },
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/aai-cli/init.test.ts --project aai-cli`
Expected: PASS

- [ ] **Step 6: Run all CLI tests**

Run: `pnpm vitest run --project aai-cli`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add packages/aai-cli/init.ts packages/aai-cli/init.test.ts packages/aai-cli/cli.ts
git commit -m "feat(aai-cli): migrate init command to structured output"
```

---

### Task 11: Integration test — verify clean JSON output end-to-end

**Files:**
- Modify: `packages/aai-cli/integration.test.ts` (add JSON output tests)

- [ ] **Step 1: Read the existing integration test file**

Read `packages/aai-cli/integration.test.ts` to understand the existing test patterns (mock API server, temp dirs, etc).

- [ ] **Step 2: Write integration tests for JSON mode**

Read the existing `packages/aai-cli/integration.test.ts` to understand its mock
API server setup and temp directory patterns. Then add a new `describe("JSON
output mode")` block using those same patterns. The tests shell out to the CLI
binary with `--json` and parse stdout:

```ts
import { execFileSync } from "node:child_process";

/** Helper: run CLI and return parsed JSON stdout. */
function runJson(args: string[], opts: { cwd: string; env?: Record<string, string> }) {
  const result = execFileSync("node", [cliPath, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Verify no ANSI escape codes
  expect(result).not.toMatch(/\x1b\[/);
  return JSON.parse(result);
}

describe("JSON output mode", () => {
  it("aai delete --json outputs structured result", async () => {
    // Uses mock API server from existing test setup
    const json = runJson(["delete", "--json"], {
      cwd: tempDir, // tempDir has .aai/project.json set up
      env: { ASSEMBLYAI_API_KEY: "test-key" },
    });
    expect(json).toEqual({ ok: true, data: { slug: expect.any(String) } });
  });

  it("aai secret list --json outputs secret names", async () => {
    const json = runJson(["secret", "list", "--json"], {
      cwd: tempDir,
      env: { ASSEMBLYAI_API_KEY: "test-key" },
    });
    expect(json).toEqual({ ok: true, data: { secrets: expect.any(Array) } });
  });

  it("JSON error on missing API key", () => {
    try {
      runJson(["deploy", "--json"], {
        cwd: tempDir,
        env: { ASSEMBLYAI_API_KEY: "" }, // clear the key
      });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      // execFileSync throws on non-zero exit
      expect(err.status).toBe(1);
      const json = JSON.parse(err.stdout);
      expect(json.ok).toBe(false);
      expect(json.code).toBe("command_failed");
    }
  });
});
```

Adapt the above to match the exact mock server and temp dir setup from the
existing integration test file. The key assertions are: (1) stdout is valid
JSON, (2) no ANSI escape codes, (3) correct `ok`/`data`/`code` shape.

- [ ] **Step 3: Run integration tests**

Run: `pnpm vitest run packages/aai-cli/integration.test.ts --project aai-cli`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/aai-cli/integration.test.ts
git commit -m "test(aai-cli): add integration tests for JSON output mode"
```

---

### Task 12: Final verification and changeset

**Files:**
- Create: `.changeset/<generated>.md`

- [ ] **Step 1: Run full CLI test suite**

Run: `pnpm vitest run --project aai-cli`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: No lint errors (or auto-fix with `pnpm lint:fix`)

- [ ] **Step 4: Run `pnpm check:local`**

Run: `pnpm check:local`
Expected: All checks pass

- [ ] **Step 5: Create changeset**

```bash
pnpm changeset:create --pkg @alexkroman1/aai-cli --bump minor --summary "Add structured JSON output for all CLI commands (auto-detected in non-TTY, --json flag)"
```

- [ ] **Step 6: Commit changeset**

```bash
git add .changeset/
git commit -m "chore: add changeset for CLI JSON output"
```
