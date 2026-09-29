// Copyright 2026 the AAI authors. MIT license.
/**
 * `endSession(ctx)` taking effect in an eval session, against a SCRIPTED model.
 *
 * The failure this pins was silent: a phone agent's `end_call` called
 * `endSession(ctx)`, which found no ender registered for an eval session and
 * answered `false` — so the "hang-up" had no effect, the session kept
 * answering, and `onSessionEnd` fired only when the case closed it. Each claim
 * below is read from what the SESSION did, never from the tool's name.
 */

import { type AgentDef, agent, endSession, tool } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { withTools } from "@alexkroman1/aai/manifest";
import { createStubWorkflows } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { registerLlmKind } from "../providers/resolve.ts";
import { watchSessionEndHook } from "./_session-end.ts";
import { openEvalSession } from "./session.ts";
import { END_CALL_TOOL, simulateCall } from "./simulate.ts";
import { installStubLlm } from "./stub-llm.ts";

let kinds = 0;

/** A scripted LLM registered like a real provider, one kind per call. */
function scripted(steps: Parameters<typeof createFakeLanguageModel>[0]) {
  kinds += 1;
  const kind = `eval-end-spec-llm-${kinds}`;
  const release = registerLlmKind(kind, {
    envVar: "EVAL_END_SPEC_LLM_KEY",
    label: "Eval end spec",
    create: () => createFakeLanguageModel(steps),
  });
  return {
    llm: { kind, options: { model: "stub" } },
    providerEnv: { EVAL_END_SPEC_LLM_KEY: "k" },
    release,
  };
}

/** A phone agent's hang-up, with `afterReply` chosen per agent. */
function hangUp(afterReply: boolean) {
  return tool({
    description: "Hang up once the caller has said goodbye.",
    inputSchema: z.object({}),
    execute: (_args, ctx) => ({ ended: endSession(ctx, { afterReply }) }),
  });
}

/** The two model calls a goodbye turn takes: the tool, then the line. */
const GOODBYE = [
  [{ type: "tool-call" as const, toolCallId: "c1", toolName: "end_call", input: "{}" }],
  [{ type: "text" as const, text: "Thanks for calling, goodbye!" }],
];

describe("endSession(ctx) in an eval session", () => {
  test("ends the session after the reply: the goodbye is captured, then the line is dead", async () => {
    const { llm, providerEnv, release } = scripted({ steps: GOODBYE });
    const ended = vi.fn();
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Caller", onSessionEnd: ended }), {
        end_call: hangUp(true),
      }),
      llm,
      providerEnv,
    });
    try {
      expect(session.ended).toBe(false);
      const turn = await session.say("That's everything, bye!");
      // The reply finished before the end took effect — as a real connection
      // lets the goodbye play — so the turn is whole.
      expect(turn.endedSession).toBe(true);
      expect(turn.completed).toBe(true);
      expect(turn.text).toBe("Thanks for calling, goodbye!");
      // `endSession` found a live session to end: the ender was registered.
      expect(turn.toolCalls[0]?.result).toContain('"ended":true');
      expect(session.ended).toBe(true);
      // The session's ordinary stop: `onSessionEnd` fired when the agent hung
      // up, before the case closed anything.
      expect(ended).toHaveBeenCalledTimes(1);
      await expect(session.say("Hello? Are you still there?")).rejects.toThrow(
        /the agent ENDED this session.*endedSession/s,
      );
    } finally {
      await session.close();
      release();
    }
    // Closing an ended session stops nothing twice.
    expect(ended).toHaveBeenCalledTimes(1);
  });

  test("with { afterReply: false } the line goes dead at once, and say() still returns", async () => {
    // No terminator comes for a reply cut off mid-way; the turn must not wait
    // out its deadline for one.
    const { llm, providerEnv, release } = scripted({ steps: GOODBYE });
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Caller" }), { end_call: hangUp(false) }),
      llm,
      providerEnv,
      turnTimeoutMs: 5000,
    });
    try {
      const turn = await session.say("Bye.");
      expect(turn.endedSession).toBe(true);
      expect(session.ended).toBe(true);
      await expect(session.say("Hello?")).rejects.toThrow(/ENDED/);
    } finally {
      await session.close();
      release();
    }
  });

  test("a turn that ends nothing says so, and the session stays open", async () => {
    const { llm, providerEnv, release } = scripted({
      steps: [[{ type: "text", text: "Sure, one moment." }]],
    });
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Caller" }), { end_call: hangUp(true) }),
      llm,
      providerEnv,
    });
    try {
      const turn = await session.say("Hold on a second.");
      expect(turn.endedSession).toBe(false);
      expect(session.ended).toBe(false);
    } finally {
      await session.close();
      release();
    }
  });

  test("sayAll stops after the turn that hung up, rather than talking to a dead line", async () => {
    const { llm, providerEnv, release } = scripted({
      steps: [[{ type: "text", text: "Anything else?" }], ...GOODBYE],
    });
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Caller" }), { end_call: hangUp(true) }),
      llm,
      providerEnv,
    });
    try {
      const turns = await session.sayAll(["Thanks.", "No, that's all. Bye!", "Hello?"]);
      expect(turns.map((t) => t.endedSession)).toEqual([false, true]);
    } finally {
      await session.close();
      release();
    }
  });

  test("a simulated call stops when the AGENT hangs up, reported as endedBy 'agent'", async () => {
    const agentLlm = scripted({ steps: [[{ type: "text", text: "Anything else?" }], ...GOODBYE] });
    // A caller that would keep talking: only the agent's hang-up can end it.
    const callerLlm = installStubLlm([
      "Thanks.",
      "No, that's all.",
      "Hello?",
      { tool: END_CALL_TOOL, args: { reason: "never reached" } },
    ]);
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Caller" }), { end_call: hangUp(true) }),
      llm: agentLlm.llm,
      providerEnv: agentLlm.providerEnv,
    });
    try {
      const call = await simulateCall(session, {
        caller: { persona: "a regular", goal: "say thanks and hang up" },
        llm: callerLlm.llm,
        providerEnv: callerLlm.env,
      });
      expect(call.endedBy).toBe("agent");
      expect(call.endReason).toBeUndefined();
      expect(call.turns.map((t) => t.caller)).toEqual(["Thanks.", "No, that's all."]);
      expect(call.turns.at(-1)?.turn.text).toBe("Thanks for calling, goodbye!");
    } finally {
      await session.close();
      callerLlm.release();
      agentLlm.release();
    }
  });
});

/** What the runtime hands `onSessionEnd`, for calling a watched hook directly. */
const HOOK_ARGS: Parameters<NonNullable<AgentDef["onSessionEnd"]>>[0] = {
  sessionId: "s",
  env: {},
  lastEventIndex: 0,
  workflows: createStubWorkflows(),
};

describe("the ending turn waits for onSessionEnd", () => {
  /** A hook whose write lands a tick AFTER it was called, as a network write does. */
  function slowWrite(rows: string[], ms: number) {
    return async () => {
      await sleep(ms);
      rows.push("ended");
    };
  }

  test("the turn that hung up returns with the hook's write already landed", async () => {
    const { llm, providerEnv, release } = scripted({ steps: GOODBYE });
    const rows: string[] = [];
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Caller", onSessionEnd: slowWrite(rows, 50) }), {
        end_call: hangUp(true),
      }),
      llm,
      providerEnv,
    });
    try {
      const turn = await session.say("That's everything, bye!");
      expect(turn.endedSession).toBe(true);
      // No `vi.waitFor`: the fire-and-forget hook has settled by now.
      expect(rows).toEqual(["ended"]);
    } finally {
      await session.close();
      release();
    }
  });

  test("close() waits for the hook its own stop fires", async () => {
    const { llm, providerEnv, release } = scripted({
      steps: [[{ type: "text", text: "Sure." }]],
    });
    const rows: string[] = [];
    const session = await openEvalSession({
      agent: agent({ name: "Caller", onSessionEnd: slowWrite(rows, 50) }),
      llm,
      providerEnv,
    });
    await session.say("Hi.");
    await session.close();
    release();
    expect(rows).toEqual(["ended"]);
  });

  test("a hook that never settles is waited for only so long", async () => {
    const watched = watchSessionEndHook(
      agent({ name: "Caller", onSessionEnd: () => new Promise<void>(() => undefined) }),
      20,
    );
    // Not called yet: nothing to wait for.
    await watched.settled();
    // Called and left pending, as the runtime leaves it.
    void watched.agent.onSessionEnd?.(HOOK_ARGS);
    const started = Date.now();
    await watched.settled();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a hook that rejects is settled, and its rejection still reaches the runtime", async () => {
    const watched = watchSessionEndHook(
      agent({ name: "Caller", onSessionEnd: () => Promise.reject(new Error("db down")) }),
    );
    const result = watched.agent.onSessionEnd?.(HOOK_ARGS);
    await expect(result).rejects.toThrow("db down");
    await expect(watched.settled()).resolves.toBeUndefined();
  });
});
