// Copyright 2026 the AAI authors. MIT license.
/**
 * WHO an eval session is — `clientId`, `phone` and `call` — asserted from the
 * places the runtime reads them back, never from where the harness wrote them.
 *
 * The claim is "nothing downstream can tell an eval session from a real
 * connection", so each reader a real connection reaches is read here: a tool's
 * `sessionClientId`/`sessionClientPhone`/`sessionCall`, the `sessionContext`
 * hook's own arguments, and `onSessionEnd`. The hook's three answers that
 * change a session — `refuse`, `instructions`, `greeting` — are each pinned by
 * what the session then DID.
 */

import {
  agent,
  type SessionContextArgs,
  sessionCall,
  sessionClientId,
  sessionClientPhone,
  tool,
} from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createFakeLanguageModel } from "../_fake-llm.ts";
import { registerLlmKind } from "../providers/resolve.ts";
import { openEvalSession } from "./session.ts";

const SPEC_LLM_KIND = "eval-identity-spec-llm";
const SPEC_LLM_ENV = "EVAL_IDENTITY_SPEC_LLM_KEY";

/** A scripted LLM registered like a real provider, and the model to read calls off. */
function scripted(steps: Parameters<typeof createFakeLanguageModel>[0]) {
  const model = createFakeLanguageModel(steps);
  const release = registerLlmKind(SPEC_LLM_KIND, {
    envVar: SPEC_LLM_ENV,
    label: "Eval identity spec",
    create: () => model,
  });
  return {
    llm: { kind: SPEC_LLM_KIND, options: { model: "stub" } },
    providerEnv: { [SPEC_LLM_ENV]: "spec-key" },
    model,
    release,
  };
}

/** The fictional call every case places. */
const CALL = { carrier: "twilio", callId: "CA_eval_0001", parameters: { call: "call_7f3a" } };

const whoAmI = tool({
  description: "Report who this session is.",
  inputSchema: z.object({}),
  execute: (_args, ctx) =>
    JSON.stringify({
      client: sessionClientId(ctx) ?? null,
      phone: sessionClientPhone(ctx) ?? null,
      call: sessionCall(ctx)?.parameters.call ?? null,
    }),
});

describe("openEvalSession — clientId, phone and call", () => {
  test("a tool reads all three back, as it would on a real connection", async () => {
    const { llm, providerEnv, release } = scripted({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "who_am_i", input: "{}" }],
        [{ type: "text", text: "Done." }],
      ],
    });
    const session = await openEvalSession({
      agent: withTools(agent({ name: "Speaker" }), { who_am_i: whoAmI }),
      llm,
      providerEnv,
      clientId: "eval-kitchen-speaker",
      // Written the way a person writes it; recorded as the socket records it.
      phone: "+1 (503) 555-0100",
      call: CALL,
    });
    try {
      const turn = await session.say("who are you talking to?");
      expect(JSON.parse(turn.toolCalls[0]?.result ?? "{}")).toEqual({
        client: "eval-kitchen-speaker",
        phone: "+15035550100",
        call: "call_7f3a",
      });
    } finally {
      await session.close();
      release();
    }
  });

  test("sessionContext receives them as its args, and onSessionEnd too", async () => {
    const { llm, providerEnv, release } = scripted({ steps: [[{ type: "text", text: "Hi." }]] });
    const seen = vi.fn((_args: SessionContextArgs) => undefined);
    const ended = vi.fn();
    const session = await openEvalSession({
      agent: agent({ name: "Caller", sessionContext: seen, onSessionEnd: ended }),
      llm,
      providerEnv,
      clientId: "eval-kitchen-speaker",
      call: CALL,
    });
    try {
      expect(session.refused).toBeUndefined();
      expect(seen).toHaveBeenCalledTimes(1);
      expect(seen.mock.calls[0]?.[0]).toMatchObject({
        sessionId: session.id,
        clientId: "eval-kitchen-speaker",
        call: CALL,
      });
    } finally {
      await session.close();
      release();
    }
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(ended.mock.calls[0]?.[0]).toMatchObject({
      clientId: "eval-kitchen-speaker",
      call: CALL,
    });
  });

  test("none given: every reader answers undefined, the honest answer for a bare session", async () => {
    const { llm, providerEnv, release } = scripted({ steps: [[{ type: "text", text: "Hi." }]] });
    const seen = vi.fn((_args: SessionContextArgs) => undefined);
    const session = await openEvalSession({
      agent: agent({ name: "Bare", sessionContext: seen }),
      llm,
      providerEnv,
    });
    try {
      const args = seen.mock.calls[0]?.[0];
      expect(args?.clientId).toBeUndefined();
      expect(args?.call).toBeUndefined();
    } finally {
      await session.close();
      release();
    }
  });

  test("a phone number that is not E.164 THROWS, where the socket would drop it", async () => {
    await expect(
      openEvalSession({ agent: agent({ name: "Speaker" }), phone: "503-555-0100" }),
    ).rejects.toThrow(/"503-555-0100" is not an E\.164 number/);
  });

  test("an empty clientId throws rather than recording a client named nothing", async () => {
    await expect(
      openEvalSession({ agent: agent({ name: "Speaker" }), clientId: " " }),
    ).rejects.toThrow(/`clientId` is empty/);
  });
});

describe("openEvalSession — sessionContext's answers take effect", () => {
  test("a greeting it answers for the call is the one the session opens with", async () => {
    const { llm, providerEnv, release } = scripted({ steps: [[{ type: "text", text: "Hi." }]] });
    const session = await openEvalSession({
      agent: agent({
        name: "Caller",
        greeting: "Hello from the agent's own greeting.",
        sessionContext: ({ call }) =>
          call ? { greeting: "Hi, this is an AI assistant calling on behalf of Sam." } : undefined,
      }),
      llm,
      providerEnv,
      call: CALL,
    });
    try {
      expect(session.said()).toEqual(["Hi, this is an AI assistant calling on behalf of Sam."]);
    } finally {
      await session.close();
      release();
    }
  });

  test("an agent with no greeting still waits out one the hook answers", async () => {
    // Without the wait the greeting would land INSIDE the first case's turn.
    const { llm, providerEnv, release } = scripted({ steps: [[{ type: "text", text: "Sure." }]] });
    const session = await openEvalSession({
      agent: agent({
        name: "Caller",
        greeting: "",
        sessionContext: () => ({ greeting: "Hi, calling on behalf of Sam." }),
      }),
      llm,
      providerEnv,
    });
    try {
      expect(session.said()).toEqual(["Hi, calling on behalf of Sam."]);
      const turn = await session.say("Go ahead.");
      expect(turn.text).toBe("Sure.");
    } finally {
      await session.close();
      release();
    }
  });

  test("an answered EMPTY greeting opens silently, and the wait does not sit out its deadline", async () => {
    const { llm, providerEnv, release } = scripted({ steps: [[{ type: "text", text: "Hi." }]] });
    const session = await openEvalSession({
      agent: agent({
        name: "Caller",
        greeting: "The agent's own greeting.",
        sessionContext: () => ({ greeting: "" }),
      }),
      llm,
      providerEnv,
      // Short enough that waiting for a greeting nobody will say fails the case.
      turnTimeoutMs: 2000,
    });
    try {
      expect(session.said()).toEqual([]);
    } finally {
      await session.close();
      release();
    }
  });

  test("instructions it answers reach the model's system prompt", async () => {
    const { llm, providerEnv, model, release } = scripted({
      steps: [[{ type: "text", text: "Booking it." }]],
    });
    const session = await openEvalSession({
      agent: agent({
        name: "Caller",
        sessionContext: ({ call }) => ({
          instructions: `You are placing call ${call?.parameters.call ?? "none"} for Bellissimo Trattoria.`,
        }),
      }),
      llm,
      providerEnv,
      call: CALL,
    });
    try {
      await session.say("Bellissimo Trattoria, how can I help?");
      expect(JSON.stringify(model.calls.at(-1)?.prompt)).toContain(
        "You are placing call call_7f3a for Bellissimo Trattoria.",
      );
    } finally {
      await session.close();
      release();
    }
  });

  test("a refusal is a VALUE on the session, and say() then rejects naming it", async () => {
    const { llm, providerEnv, model, release } = scripted({
      steps: [[{ type: "text", text: "never said" }]],
    });
    const ended = vi.fn();
    const session = await openEvalSession({
      agent: agent({
        name: "Caller",
        sessionContext: ({ call }) =>
          call?.parameters.call === "call_7f3a" ? undefined : { refuse: "not a call we placed" },
        onSessionEnd: ended,
      }),
      llm,
      providerEnv,
      call: { carrier: "twilio", parameters: { call: "call_unknown" } },
    });
    try {
      expect(session.refused).toBe("not a call we placed");
      // Refused before the transport started: no greeting, no model call.
      expect(session.said()).toEqual([]);
      expect(model.calls).toEqual([]);
      await expect(session.say("hello?")).rejects.toThrow(
        /sessionContext REFUSED this session \("not a call we placed"\).*session\.refused/,
      );
    } finally {
      await session.close();
      release();
    }
    // As in production: a refused session never began, so nothing digests it.
    expect(ended).not.toHaveBeenCalled();
  });
});
