// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the `aai secret` / `aai logs` command GROUP — its
 * wiring, not its executors (those are `secret.test.ts` and
 * `logs.test.ts`).
 *
 * Two things live at this layer and nowhere else: the verbs being reachable at
 * all, and each one reaching its executor with the arguments the flags mean —
 * including the optional `[dir]`, which every verb resolves against the
 * working directory rather than passing through.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { logs, secret } from "./_resource-commands.ts";

const ok = { ok: true, data: {} };
const executors = vi.hoisted(() => ({
  secret: {
    executeSecretPut: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    executeSecretDelete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    executeSecretList: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    readStdin: vi.fn().mockResolvedValue("s3cret"),
    NO_INPUT: ["no_input", "nothing on stdin"] as const,
  },
  logs: { executeLogs: vi.fn().mockResolvedValue({ ok: true, data: {} }) },
}));
vi.mock("./secret.ts", () => executors.secret);
vi.mock("./logs.ts", () => executors.logs);

// Module-level `vi.fn()`s: `restoreMocks` registers only `vi.spyOn` mocks, so
// without this a `toHaveBeenCalledWith` can be satisfied by an earlier test.
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(executors.secret))
    if (vi.isMockFunction(fn)) fn.mockResolvedValue(ok);
  executors.logs.executeLogs.mockResolvedValue(ok);
  executors.secret.readStdin.mockResolvedValue("s3cret");
});

type Runnable = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> };
// Two narrowings in one place rather than a cast per call: citty's own `run`
// takes a full `CommandContext` (rawArgs, cmd, data) that `defineExec` never
// reads, so a spec supplying one would be describing the framework instead of
// the command.
const subsOf = (group: unknown): Record<string, Runnable> =>
  (group as { subCommands: Record<string, Runnable> }).subCommands;
const runnable = (cmd: unknown): Runnable => cmd as Runnable;

describe("the secret command group", () => {
  test.each(["put", "delete", "list"])("declares the %s verb", (name) => {
    expect(subsOf(secret)[name]).toBeDefined();
  });

  test("put reads the value off stdin in JSON mode", async () => {
    await subsOf(secret).put?.run({ args: { name: "OPENAI_API_KEY", json: true } });
    expect(executors.secret.readStdin).toHaveBeenCalled();
    expect(executors.secret.executeSecretPut).toHaveBeenCalledWith(
      expect.any(String),
      "OPENAI_API_KEY",
      "s3cret",
      undefined,
    );
  });

  test("put prompts instead in human mode — the value is not read from stdin", async () => {
    await subsOf(secret).put?.run({ args: { name: "OPENAI_API_KEY", json: false } });
    expect(executors.secret.readStdin).not.toHaveBeenCalled();
    expect(executors.secret.executeSecretPut).toHaveBeenCalledWith(
      expect.any(String),
      "OPENAI_API_KEY",
      undefined,
      undefined,
    );
  });

  test("delete and list reach their executors with the server flag", async () => {
    await subsOf(secret).delete?.run({ args: { name: "OLD", server: "https://s", json: false } });
    await subsOf(secret).list?.run({ args: { server: "https://s", json: false } });
    expect(executors.secret.executeSecretDelete).toHaveBeenCalledWith(
      expect.any(String),
      "OLD",
      "https://s",
    );
    expect(executors.secret.executeSecretList).toHaveBeenCalledWith(
      expect.any(String),
      "https://s",
    );
  });
});

describe("aai logs", () => {
  test("forwards --follow and the resolved directory", async () => {
    await runnable(logs).run({ args: { follow: true, json: false } });
    expect(executors.logs.executeLogs).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ follow: true }),
    );
  });
});
