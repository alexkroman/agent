// Copyright 2026 the AAI authors. MIT license.
/**
 * The SDK ADAPTER's two pure halves — the exec-stream pump and the name reclaim
 * — driven with hand-built fakes, so the `microsandbox` SDK is never imported.
 * Moved from `sandbox.test.ts` beside the module that now owns them.
 */

import { describe, expect, it, vi } from "vitest";
import { SandboxNameTakenError } from "../sandbox/directory.ts";
import { _contextInternals } from "./context.ts";

// ── The stdio adapter ────────────────────────────────────────────────────────

describe("procFromExec", () => {
  /** Drain a stream to one string. */
  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    let text = "";
    for await (const chunk of stream) text += new TextDecoder().decode(chunk);
    return text;
  }

  it("splits one tagged event stream into stdout, stderr and an exit code", async () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    const events = [
      { kind: "started" as const, pid: 7 },
      { kind: "stdout" as const, data: encode("out-1") },
      { kind: "stderr" as const, data: encode("err-1") },
      { kind: "stdout" as const, data: encode("out-2") },
      { kind: "exited" as const, code: 3 },
    ];
    const proc = _contextInternals.procFromExec({
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
      kill: async () => undefined,
    });

    await expect(drain(proc.stdout)).resolves.toBe("out-1out-2");
    await expect(drain(proc.stderr)).resolves.toBe("err-1");
    await expect(proc.wait()).resolves.toBe(3);
  });

  it("reports an exit even when the stream ends without one", async () => {
    // A VM that dies mid-stream must still settle `wait()`, or every caller
    // that awaits a guest's exit hangs to its own timeout.
    const proc = _contextInternals.procFromExec({
      async *[Symbol.asyncIterator]() {
        yield { kind: "stdout" as const, data: new Uint8Array() };
      },
      kill: async () => undefined,
    });
    await expect(proc.wait()).resolves.toBe(-1);
  });

  it("survives a stream that throws", async () => {
    const proc = _contextInternals.procFromExec({
      async *[Symbol.asyncIterator]() {
        yield { kind: "stdout" as const, data: new Uint8Array() };
        throw new Error("vm died");
      },
      kill: async () => undefined,
    });
    await expect(proc.wait()).resolves.toBe(-1);
  });
});

// ── Reclaiming a name from a dead holder ─────────────────────────────────────

describe("createReclaimingName", () => {
  /**
   * `sandbox/directory.ts` rests on "a name is released when the sandbox
   * stops". That is MODAL's property, and microsandbox does not share it: its
   * store keeps the row, and `.ephemeral(true)` cannot run when the VM is
   * SIGKILLed. Measured on a real dev server — kill a running agent's
   * `msb sandbox` process and every later spawn answers `sandbox
   * 'agent-<hash>-v2' already exists`, so the slug is permanently unreachable
   * (`/client-config`, `/workflows` and the durable-run wake all answering
   * `agent unavailable, retry shortly`, a 503 that can never succeed).
   */
  const taken = new Error("sandbox already exists: sandbox 'agent-x-v2' already exists");

  /**
   * A FACTORY whose first create fails with `err`, then succeeds — and which
   * hands back a FRESH builder each time, because the real `SandboxBuilder` is
   * single-use (a reused one fails `SandboxBuilder already consumed`, which is
   * how the first draft of this fix stayed broken).
   */
  function builderFailingOnce(err: unknown) {
    let calls = 0;
    const build = () => ({
      create: async () => {
        calls += 1;
        if (calls === 1) throw err;
        return "sandbox" as const;
      },
    });
    return Object.assign(build, { calls: () => calls });
  }

  it("removes a CRASHED holder and retries the create", async () => {
    const builder = builderFailingOnce(taken);
    const removed: string[] = [];
    await expect(
      _contextInternals.createReclaimingName(builder, "agent-x-v2", {
        get: async () => ({ status: "crashed" }),
        remove: async (name: string) => void removed.push(name),
      }),
    ).resolves.toBe("sandbox");
    expect(removed).toEqual(["agent-x-v2"]);
    expect(builder.calls()).toBe(2);
  });

  it("removes a STOPPED holder too", async () => {
    const builder = builderFailingOnce(taken);
    const removed: string[] = [];
    await expect(
      _contextInternals.createReclaimingName(builder, "agent-x-v2", {
        get: async () => ({ status: "stopped" }),
        remove: async (name: string) => void removed.push(name),
      }),
    ).resolves.toBe("sandbox");
    expect(removed).toEqual(["agent-x-v2"]);
  });

  it.each(["running", "draining"])(
    "leaves a %s holder alone — that is a real peer",
    async (status) => {
      // Blue-green handover depends on this: a slug legitimately has two live
      // sandboxes for minutes, and the broker routes to the peer rather than
      // retrying a create that can only lose again.
      const builder = builderFailingOnce(taken);
      const removed: string[] = [];
      await expect(
        _contextInternals.createReclaimingName(builder, "agent-x-v2", {
          get: async () => ({ status }),
          remove: async (name: string) => void removed.push(name),
        }),
      ).rejects.toThrow(SandboxNameTakenError);
      expect(removed).toEqual([]);
      expect(builder.calls()).toBe(1);
    },
  );

  it("retries without removing when the holder is already gone", async () => {
    // The name freed itself between the failure and the read; there is nothing
    // to remove and the create should simply be retried.
    const builder = builderFailingOnce(taken);
    const removed: string[] = [];
    await expect(
      _contextInternals.createReclaimingName(builder, "agent-x-v2", {
        get: async () => {
          throw new Error("no such sandbox");
        },
        remove: async (name: string) => void removed.push(name),
      }),
    ).resolves.toBe("sandbox");
    expect(removed).toEqual([]);
    expect(builder.calls()).toBe(2);
  });

  it("rethrows any OTHER create failure untouched, reading no status", async () => {
    const builder = builderFailingOnce(new Error("no space left on device"));
    const get = vi.fn(async () => ({ status: "stopped" }));
    await expect(
      _contextInternals.createReclaimingName(builder, "agent-x-v2", {
        get,
        remove: async () => undefined,
      }),
    ).rejects.toThrow("no space left on device");
    expect(get).not.toHaveBeenCalled();
  });
});
