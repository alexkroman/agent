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
    resolveSecretValue: vi.fn().mockResolvedValue("s3cret"),
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
  executors.secret.resolveSecretValue.mockResolvedValue("s3cret");
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

  // The command layer decides the SOURCE and the executor does the rest, so
  // what belongs here is that the mode reaches the resolver and its answer
  // reaches the executor — never that this layer reads stdin itself, which is
  // the coupling that let the output mode decide whether to block on it.
  test.each([
    ["JSON", true],
    ["human", false],
  ])("put resolves the value for %s mode and passes it on", async (_label, json) => {
    await subsOf(secret).put?.run({ args: { name: "OPENAI_API_KEY", json } });
    expect(executors.secret.resolveSecretValue).toHaveBeenCalledWith(
      "OPENAI_API_KEY",
      json ? "json" : "human",
    );
    expect(executors.secret.executeSecretPut).toHaveBeenCalledWith(
      expect.any(String),
      "OPENAI_API_KEY",
      "s3cret",
      undefined,
    );
  });

  test("put passes an unresolved value through, which is the prompt request", async () => {
    executors.secret.resolveSecretValue.mockResolvedValue(undefined);
    await subsOf(secret).put?.run({ args: { name: "OPENAI_API_KEY", json: false } });
    expect(executors.secret.executeSecretPut).toHaveBeenCalledWith(
      expect.any(String),
      "OPENAI_API_KEY",
      undefined,
      undefined,
    );
  });

  /**
   * `aai secret put FOO bar` is the natural guess, and citty drops an
   * undeclared positional silently — so it used to set the secret to whatever
   * stdin yielded (nothing) and report no problem. Refused rather than
   * accepted: a value in argv is in the shell history and in `ps`.
   */
  test("put refuses a value passed as an argument, without echoing it", async () => {
    // Observed through the emitted RESULT rather than as a rejection: every
    // failure in this CLI converges on `runCommand`'s one emitter, which
    // writes the JSON line and exits 1.
    // A stub that THROWS rather than one cast to `never`: `process.exit` is
    // typed `never` and a function whose body only throws is inferred that
    // way, so the seam needs no cast — and the throw is what the assertion
    // below observes, after the JSON line has already been written.
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown, cb?: unknown) => {
      written.push(String(chunk));
      if (typeof cb === "function") cb();
      return true;
    });

    await expect(
      subsOf(secret).put?.run({ args: { name: "FOO", json: true, _: ["FOO", "hunter2"] } }),
    ).rejects.toThrow("process.exit(1)");

    const line = written.join("");
    expect(JSON.parse(line)).toMatchObject({
      ok: false,
      code: "usage",
      error: expect.stringContaining("takes only the secret NAME"),
      hint: expect.stringContaining("shell history"),
    });
    // The value itself is never repeated back — it is a credential.
    expect(line).not.toContain("hunter2");
    expect(executors.secret.executeSecretPut).not.toHaveBeenCalled();
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
