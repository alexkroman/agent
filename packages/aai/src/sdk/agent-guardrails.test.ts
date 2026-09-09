// Copyright 2026 the AAI authors. MIT license.
// `runAgentGuardrails` is the ONE implementation of "first refusal wins, a
// throw fails open" — three callers share it precisely so none of them can get
// the throw rule backwards, which makes this file the only place that rule is
// claimed. The types beside it carry no runtime, so what is asserted here is
// the runner and the vocabulary it answers in.

import { describe, expect, test, vi } from "vitest";
import type { AgentGuardrail } from "./agent-guardrails.ts";
import { runAgentGuardrails } from "./agent-guardrails.ts";
import type { AgentSessionContext } from "./agent-session-context.ts";
import { createDetachedSlotStore } from "./session-state.ts";

const CTX: AgentSessionContext = {
  sessionId: "s-1",
  env: { TIER: "gold" },
  slots: createDetachedSlotStore(),
};

/** A guardrail that always answers the same verdict, and counts its calls. */
function always(verdict: true | string) {
  return vi.fn<AgentGuardrail>(() => verdict);
}

describe("runAgentGuardrails", () => {
  test("no guardrails at all is `undefined` — nothing is refused", async () => {
    // The shipped path for every agent that declares neither list. It must not
    // be distinguishable from a list that accepted.
    await expect(runAgentGuardrails(undefined, "anything", CTX, fail)).resolves.toBeUndefined();
    await expect(runAgentGuardrails([], "anything", CTX, fail)).resolves.toBeUndefined();
  });

  test("a verdict of `true` passes the text through", async () => {
    const guardrail = always(true);
    await expect(runAgentGuardrails([guardrail], "the caller's words", CTX, fail)).resolves.toBe(
      undefined,
    );
    expect(guardrail).toHaveBeenCalledWith("the caller's words", CTX);
  });

  test("a complaint STRING is the answer, and it is the string the caller hears", async () => {
    // The whole difference from a subagent guardrail: this string is spoken, so
    // it is returned verbatim rather than folded into a retry prompt.
    const spoken = "I can't help with that over the phone.";
    await expect(runAgentGuardrails([always(spoken)], "dosage?", CTX, fail)).resolves.toBe(spoken);
  });

  test("the FIRST complaint wins, and the guardrails after it never run", async () => {
    // Documented as "run in order; the first one to return a string wins". A
    // later guardrail that still ran would spend time on a live call for a
    // verdict nobody can use, and could log a second block for one utterance.
    const first = always(true);
    const second = always("blocked by the second");
    const third = always("blocked by the third");
    await expect(runAgentGuardrails([first, second, third], "text", CTX, fail)).resolves.toBe(
      "blocked by the second",
    );
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
  });

  test("a guardrail that THROWS fails open, is reported, and the rest still run", async () => {
    // The rule this runner exists to hold: a check that cannot decide has not
    // decided. Taking a call down because a moderation endpoint timed out is
    // the wrong trade — but a silent skip is a guardrail nobody knows has
    // stopped working, so `onError` is how it is announced.
    const boom = new Error("classifier timed out");
    const onError = vi.fn();
    const after = always("caught by the next one");
    await expect(
      runAgentGuardrails(
        [
          () => {
            throw boom;
          },
          after,
        ],
        "text",
        CTX,
        onError,
      ),
    ).resolves.toBe("caught by the next one");
    expect(onError).toHaveBeenCalledWith(boom);
    expect(after).toHaveBeenCalledTimes(1);
  });

  test("a throw with nothing after it lets the text through", async () => {
    const onError = vi.fn();
    await expect(
      runAgentGuardrails(
        [
          () => {
            throw new Error("down");
          },
        ],
        "text",
        CTX,
        onError,
      ),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("an ASYNC verdict is awaited, not treated as a truthy object", async () => {
    // A promise is neither `true` nor a string, so a runner that forgot the
    // `await` would pass every async guardrail's refusal through silently.
    const asyncBlock: AgentGuardrail = async () => "async refusal";
    const asyncPass: AgentGuardrail = () => Promise.resolve(true);
    await expect(runAgentGuardrails([asyncPass, asyncBlock], "text", CTX, fail)).resolves.toBe(
      "async refusal",
    );
  });

  test("a rejected async guardrail fails open like a synchronous throw", async () => {
    const onError = vi.fn();
    const rejecting: AgentGuardrail = () => Promise.reject(new Error("upstream 503"));
    await expect(runAgentGuardrails([rejecting], "text", CTX, onError)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("an EMPTY string is not a refusal — a blocked reply must have something to say", async () => {
    // The verdict string is spoken. Blocking on `""` would drop the reply and
    // put silence on the line, which reads to a caller as a dropped call.
    await expect(runAgentGuardrails([always("")], "text", CTX, fail)).resolves.toBeUndefined();
  });

  test("every guardrail sees the same text and the same session context", async () => {
    const seen: { text: string; ctx: AgentSessionContext }[] = [];
    const record: AgentGuardrail = (text, ctx) => {
      seen.push({ text, ctx });
      return true;
    };
    await runAgentGuardrails([record, record], "what was heard", CTX, fail);
    expect(seen).toEqual([
      { text: "what was heard", ctx: CTX },
      { text: "what was heard", ctx: CTX },
    ]);
    // Not merely equal: a guardrail counting strikes across a call needs the
    // session's OWN slots, not a copy of them.
    expect(seen[0]?.ctx.slots).toBe(CTX.slots);
  });
});

/**
 * An `onError` no case here may reach.
 *
 * A throw rather than `expect.fail`, which biome refuses outside a test body:
 * the runner reports a rejected `runAgentGuardrails` against the case that
 * caused it, and the sentence names what was reported.
 */
function fail(err: unknown): void {
  throw new Error(`onError was called unexpectedly: ${String(err)}`);
}
