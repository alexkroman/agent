// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for `warmFromChild`'s ChildProcess `error` handling. A failed spawn
 * (deno/runsc missing, EAGAIN under fd pressure) emits `error` on the
 * ChildProcess with no `exit` guaranteed to follow — without a listener that
 * escapes as an uncaughtException and exits the whole multi-tenant host.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { _internals } from "./sandbox-vm.ts";

function makeFakeChild() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stdin: PassThrough;
    exitCode: number | null;
    killed: boolean;
  };
  emitter.stdout = new PassThrough();
  emitter.stdin = new PassThrough();
  emitter.exitCode = null;
  emitter.killed = false;
  return emitter;
}

describe("warmFromChild", () => {
  it("treats a spawn `error` as harness death instead of an uncaught exception", () => {
    const child = makeFakeChild();
    const warm = _internals.warmFromChild(child as never, async () => undefined);
    const exits: string[] = [];
    warm.onExit(() => exits.push("exit"));

    expect(warm.alive()).toBe(true);
    // With no `error` listener this emit would throw (the uncaughtException
    // that used to take down the host on a failed deno/runsc spawn).
    child.emit("error", new Error("spawn deno ENOENT"));

    expect(exits).toEqual(["exit"]);
    expect(warm.alive()).toBe(false);
  });

  it("notifies exit listeners once when both `error` and `exit` fire", () => {
    const child = makeFakeChild();
    const warm = _internals.warmFromChild(child as never, async () => undefined);
    const exits: string[] = [];
    warm.onExit(() => exits.push("exit"));

    child.emit("error", new Error("spawn deno EAGAIN"));
    child.exitCode = 1;
    child.emit("exit", 1);

    expect(exits).toEqual(["exit"]);
    expect(warm.alive()).toBe(false);
  });
});
