// Copyright 2026 the AAI authors. MIT license.
// What a tool's exception BECOMES. Three kinds of failure, four guard rules and
// a latch — and every one of them is silent when it regresses: an unclassified
// throw reads as a result the model can retry against, a swallowed fatal verdict
// reads as a turn that simply stopped, and a latch wired to the TURN's signal
// reads as a barge-in. So this file states each rule as its own claim rather
// than exercising the policy through the executor, which is `tool-executor.test.ts`.

import type { ToolFailure } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { createMockToolContext, malformedOnError } from "./_test-utils.ts";
import {
  createFatalToolLatch,
  FatalToolError,
  isFatalToolError,
  resolveToolError,
  withFatalSignal,
} from "./tool-error-policy.ts";

const CTX = createMockToolContext();
const BOOM = new Error("upstream 503");
/** The property that makes a value awaitable, spelled so biome's rule agrees. */
const THEN = "then";

/** `resolveToolError`'s parameters, with only the fields a case varies set. */
function resolve(params: {
  onError?: Parameters<typeof resolveToolError>[0]["onError"];
  err?: unknown;
  ctx?: Parameters<typeof resolveToolError>[0]["ctx"];
  cancelled?: boolean;
}) {
  return resolveToolError({
    name: "lookup",
    err: params.err ?? BOOM,
    onError: params.onError,
    ctx: "ctx" in params ? params.ctx : CTX,
    cancelled: params.cancelled ?? false,
  });
}

describe("FatalToolError", () => {
  test("names the tool the model called and keeps the original throw as `cause`", () => {
    // The wrapper adds the name, which the raw error never has; the cause is
    // what lets a log or a test still reach the TypeError underneath.
    const error = new FatalToolError("lookup", BOOM);
    expect(error.name).toBe("FatalToolError");
    expect(error.toolName).toBe("lookup");
    expect(error.message).toBe('Tool "lookup" failed fatally: upstream 503');
    expect(error.cause).toBe(BOOM);
  });

  test("a non-Error cause still produces a readable sentence", () => {
    expect(new FatalToolError("lookup", "just a string").message).toContain("just a string");
  });

  test("isFatalToolError tells one from every other rejection", () => {
    expect(isFatalToolError(new FatalToolError("lookup", BOOM))).toBe(true);
    expect(isFatalToolError(BOOM)).toBe(false);
    expect(isFatalToolError(undefined)).toBe(false);
    expect(isFatalToolError({ name: "FatalToolError" })).toBe(false);
  });
});

describe("resolveToolError: the four guard rules", () => {
  test("a CANCELLED call is not a tool fault — onError is not consulted at all", () => {
    // A barge-in, a reset, `stop()` or the per-call deadline describes the
    // RUNTIME, not the tool. Without this, every handler would have to filter
    // aborts before it could classify anything, and one that forgot would turn
    // an ordinary interruption into a fatal failure.
    const onError = vi.fn(() => "recovered");
    expect(resolve({ onError, cancelled: true })).toEqual({ kind: "default" });
    expect(onError).not.toHaveBeenCalled();
  });

  test("`undefined` means NOT HANDLED, and falls through to the default", () => {
    // A handler written to log and nothing else returns nothing. Stringifying
    // that would hand the model the string "null" as the tool's answer.
    expect(resolve({ onError: malformedOnError(() => undefined) })).toEqual({ kind: "default" });
  });

  test("a THENABLE return is refused, fatally, naming the contract it broke", () => {
    // The handler is synchronous by contract — there is no budget left to await
    // in — so an `async` one's promise would serialize as `{}` and the model
    // would read an empty object as the result.
    const resolution = resolve({
      onError: malformedOnError(() => Promise.resolve("too late")),
    });
    expect(resolution.kind).toBe("fatal");
    expect(isFatalToolError(resolution.kind === "fatal" ? resolution.error : undefined)).toBe(true);
    expect(resolution.kind === "fatal" ? resolution.error.cause : undefined).toBeInstanceOf(
      TypeError,
    );
    expect(resolution.kind === "fatal" ? resolution.error.message : "").toContain(
      "returned a promise",
    );
  });

  test("a bare thenable counts too — the test is the shape, not `instanceof Promise`", () => {
    // A hand-rolled thenable serializes as badly as a real promise, so the
    // guard asks whether `then` is CALLABLE rather than what the value is. The
    // key is computed because biome refuses a literal `then` property — which
    // is the same hazard from the authoring side.
    const thenable: Record<string, unknown> = { [THEN]: () => undefined };
    const resolution = resolve({ onError: malformedOnError(() => thenable) });
    expect(resolution.kind).toBe("fatal");
  });

  test("a handler that throws for its OWN reason is fatal, carrying ITS error", () => {
    // A TypeError inside `onError` is not a classification, and there is
    // nothing left to ask. Treating it as recoverable would send the model a
    // message about the handler rather than about the tool.
    const handlerErr = new TypeError("cannot read properties of undefined");
    const resolution = resolve({
      onError: () => {
        throw handlerErr;
      },
    });
    expect(resolution.kind).toBe("fatal");
    expect(resolution.kind === "fatal" ? resolution.error.cause : undefined).toBe(handlerErr);
  });
});

describe("resolveToolError: the three outcomes", () => {
  test("no handler is `default`, byte-identical to the behaviour before onError existed", () => {
    // Not a pre-built recoverable outcome: every tool written before this field
    // existed depends on the throw arriving as a result, at the same log level,
    // with `onUncaught` firing.
    expect(resolve({ onError: undefined })).toEqual({ kind: "default" });
  });

  test("an absent CONTEXT is `default` — that is a framework bug, not a tool one", () => {
    const onError = vi.fn(() => "recovered");
    expect(resolve({ onError, ctx: undefined })).toEqual({ kind: "default" });
    expect(onError).not.toHaveBeenCalled();
  });

  test("a handler's answer is `recovered`, and the VALUE is what the model reads", () => {
    expect(resolve({ onError: () => "the upstream is down; try later" })).toEqual({
      kind: "recovered",
      value: "the upstream is down; try later",
    });
  });

  test("a ToolFailure answer rides through unserialized — the executor owns that", () => {
    const failure: ToolFailure = { error: "no such city" };
    expect(resolve({ onError: () => failure })).toEqual({ kind: "recovered", value: failure });
  });

  test("the handler is handed the throw and the tool's own context", () => {
    const onError = vi.fn(() => "ok");
    resolve({ onError });
    expect(onError).toHaveBeenCalledWith(BOOM, CTX);
  });
});

describe("createFatalToolLatch", () => {
  test("a fresh latch has no error and an un-aborted signal", () => {
    // The correct reading of "no fatal tool error has happened" — a latch that
    // was never reset must not look like one that fired.
    const latch = createFatalToolLatch();
    expect(latch.error()).toBeUndefined();
    expect(latch.signal().aborted).toBe(false);
  });

  test("a report aborts this turn's signal and keeps the error", () => {
    // The error is kept, not just the fact of it: the turn reports which tool
    // killed it, and a reader that only saw an AbortError could not say.
    const latch = createFatalToolLatch();
    const error = new FatalToolError("lookup", BOOM);
    const signal = latch.signal();
    latch.report(error);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(error);
    expect(latch.error()).toBe(error);
  });

  test("the FIRST report wins — a step runs its tool calls concurrently", () => {
    // Two can fail fatally in one step. The turn is over either way, and the
    // one that stopped it is the one that got there first.
    const latch = createFatalToolLatch();
    const first = new FatalToolError("a", BOOM);
    latch.report(first);
    latch.report(new FatalToolError("b", BOOM));
    expect(latch.error()).toBe(first);
  });

  test("reset mints a FRESH signal, which is what makes one latch per session safe", () => {
    // A pipeline transport builds its tool set once per session and runs many
    // turns through it, so a controller minted beside the tools would abort
    // every later turn too.
    const latch = createFatalToolLatch();
    const firstTurn = latch.signal();
    latch.report(new FatalToolError("lookup", BOOM));
    latch.reset();
    const secondTurn = latch.signal();
    expect(firstTurn.aborted).toBe(true);
    expect(secondTurn).not.toBe(firstTurn);
    expect(secondTurn.aborted).toBe(false);
    expect(latch.error()).toBeUndefined();
  });
});

describe("withFatalSignal", () => {
  test("combines the caller's signal with the latch's, WITHOUT aborting the turn's", () => {
    // The whole reason the mechanism works: aborting the turn's own signal
    // would make a fatal tool error indistinguishable from a barge-in — an
    // `[interrupted]` tail, no TTS drain, nothing spoken — where what it must
    // produce is a FAILED turn the caller hears `errorPhrase` on.
    const turn = new AbortController();
    const latch = createFatalToolLatch();
    const request = withFatalSignal(turn.signal, latch);
    expect(request.aborted).toBe(false);
    latch.report(new FatalToolError("lookup", BOOM));
    expect(request.aborted).toBe(true);
    expect(turn.signal.aborted).toBe(false);
  });

  test("the caller's own abort still stops the request", () => {
    const turn = new AbortController();
    const request = withFatalSignal(turn.signal, createFatalToolLatch());
    turn.abort();
    expect(request.aborted).toBe(true);
  });

  test("no latch yields the caller's signal itself, not a wrapper", () => {
    // Every session without a fatal-tool latch must run on the same object it
    // always did — combining would leave a listener on a hot path for nothing.
    const turn = new AbortController();
    expect(withFatalSignal(turn.signal, undefined)).toBe(turn.signal);
  });

  test("no caller signal (text mode's optional turn.signal) yields the latch's alone", () => {
    const latch = createFatalToolLatch();
    expect(withFatalSignal(undefined, latch)).toBe(latch.signal());
  });

  test("neither is undefined", () => {
    expect(withFatalSignal(undefined, undefined)).toBeUndefined();
  });
});
