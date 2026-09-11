// Copyright 2026 the AAI authors. MIT license.

import type { EndpointingRule } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "../_test-utils.ts";
import { createEndpointingPolicy } from "./pipeline-endpointing.ts";

const BASE = 1600;
const CEILING = 3500;

function makePolicy(
  rules: readonly EndpointingRule[],
  opts: {
    lastAgentMessage?: string | undefined;
    /** `false` models a provider with no mid-stream reconfigure verb. */
    supported?: boolean;
  } = {},
) {
  const pushed: number[] = [];
  const update = (ms: number): void => {
    pushed.push(ms);
  };
  const log = makeLogger();
  const policy = createEndpointingPolicy({
    rules,
    baseTimeoutMs: BASE,
    maxTurnSilenceMs: CEILING,
    lastAgentMessage: () => opts.lastAgentMessage,
    apply: () => (opts.supported === false ? undefined : update),
    log,
    sid: "t",
  });
  return { policy, pushed, log };
}

describe("what reaches the provider", () => {
  test("a matching rule REPLACES the window, and the override is pushed once", () => {
    const { policy, pushed } = makePolicy([{ type: "user", regex: "\\d$", timeoutMs: 2600 }]);
    policy.onUserPartial("one nine one");
    expect(pushed).toEqual([]);
    policy.onUserPartial("one nine 1");
    expect(pushed).toEqual([2600]);
    // Still matching: no second frame for the same answer.
    policy.onUserPartial("one nine 12");
    expect(pushed).toEqual([2600]);
  });

  test("the window goes back to the BASE when the rule stops matching", () => {
    const { policy, pushed } = makePolicy([{ type: "user", regex: "\\d$", timeoutMs: 2600 }]);
    policy.onUserPartial("19");
    policy.onUserPartial("19 please");
    expect(pushed).toEqual([2600, BASE]);
  });

  test("the utterance ending drops a user-keyed window, so it cannot outlive its turn", () => {
    const { policy, pushed } = makePolicy([{ type: "user", regex: "\\d$", timeoutMs: 2600 }]);
    policy.onUserPartial("19");
    policy.onUtteranceEnded();
    expect(pushed).toEqual([2600, BASE]);
  });

  test("an assistant-keyed window SURVIVES the utterance, since the agent's message has not moved", () => {
    const { policy, pushed } = makePolicy(
      [{ type: "assistant", regex: "order number", timeoutMs: 2600 }],
      { lastAgentMessage: "What's your order number?" },
    );
    policy.onUserPartial("it's");
    policy.onUtteranceEnded();
    expect(pushed).toEqual([2600]);
  });

  test("a rule above the session's ceiling is clamped to it, never inverting the pair", () => {
    const { policy, pushed } = makePolicy([{ type: "user", regex: "x", timeoutMs: 5000 }]);
    policy.onUserPartial("x");
    expect(pushed).toEqual([CEILING]);
  });

  test("a shorter window passes through — the yes/no case", () => {
    const { policy, pushed } = makePolicy([{ type: "assistant", regex: "\\?$", timeoutMs: 900 }], {
      lastAgentMessage: "Is that right?",
    });
    policy.onUserPartial("y");
    expect(pushed).toEqual([900]);
  });
});

describe("what is inert", () => {
  test("an empty table pushes nothing at all", () => {
    const { policy, pushed } = makePolicy([]);
    policy.onUserPartial("19");
    policy.onUtteranceEnded();
    expect(pushed).toEqual([]);
  });

  test("a provider with no mid-stream verb is WARNED once, not silently ignored", () => {
    const { policy, log } = makePolicy([{ type: "user", regex: "\\d$", timeoutMs: 2600 }], {
      supported: false,
    });
    policy.onUserPartial("19");
    policy.onUserPartial("19 2");
    policy.onUtteranceEnded();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain("endpointingRules");
  });

  test("a session whose provider cannot honour the table still reports the state it is in", () => {
    // The value in force never moves, so a later provider (a reconnect that
    // DOES expose the verb) still gets the override rather than being told
    // the window is already where the rules want it.
    const update = vi.fn();
    let verb: ((ms: number) => void) | undefined;
    const policy = createEndpointingPolicy({
      rules: [{ type: "user", regex: "\\d$", timeoutMs: 2600 }],
      baseTimeoutMs: BASE,
      maxTurnSilenceMs: CEILING,
      lastAgentMessage: () => undefined,
      apply: () => verb,
      log: makeLogger(),
      sid: "t",
    });
    policy.onUserPartial("19");
    expect(update).not.toHaveBeenCalled();
    verb = update;
    policy.onUserPartial("192");
    expect(update).toHaveBeenCalledWith(2600);
  });
});
