// Copyright 2026 the AAI authors. MIT license.
/**
 * `speech.say`/`interrupt` end to end, through a real runtime over fake
 * pipeline providers: an `events` handler speaking through `ctx.speech`, and a
 * webhook route reaching a live call through `ctx.speech(sessionId)`.
 *
 * The pieces have their own specs (`session/speech.test.ts` for the session
 * half, `transports/pipeline/say.test.ts` for the transport's). What only this
 * file shows is the WIRING: that the handle an author is given is bound to the
 * session in the runtime's map, so a `say` from either surface reaches TTS
 * verbatim, and a route asking for an id no call holds gets `undefined`.
 */

import type { AgentDef, SpeechOutcome } from "@alexkroman1/aai";
import { routeResponse } from "@alexkroman1/aai";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  FAKE_STT_API_KEY_ENV,
  FAKE_TTS_API_KEY_ENV,
  registerFakeProviders,
} from "../_pipeline-test-fakes.ts";
import { makeAgent, makeClientSink, silentLogger } from "../_test-utils.ts";
import { connectSession } from "./connect.ts";
import { createRuntimeWithSeams } from "./runtime.ts";

const GREETING = "Hello there.";

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

/** A live pipeline call of `agent`, with what TTS was asked to say. */
async function liveCall(agent: Partial<AgentDef>) {
  const stt = createFakeSttProvider();
  const tts = createFakeTtsProvider();
  const llm = createFakeLanguageModel({ script: [{ type: "text", text: "unused" }] });
  const fakes = registerFakeProviders({ stt, tts, llm });
  unregister = fakes.unregister;
  const runtime = createRuntimeWithSeams({
    agent: makeAgent({ greeting: GREETING, ...agent }),
    env: { ...fakes.env, [FAKE_STT_API_KEY_ENV]: "stt-key", [FAKE_TTS_API_KEY_ENV]: "tts-key" },
    logger: silentLogger,
    stt: fakes.stt,
    llm: fakes.llm,
    tts: fakes.tts,
  });
  const client = makeClientSink();
  const connection = connectSession(runtime, client);
  const sessionId = connection.id;
  const spoken = (): string => tts.sessions.flatMap((s) => s.textChunks).join("");
  return { runtime, connection, sessionId, spoken, llm };
}

describe("speech through the runtime (pipeline)", () => {
  test("an events handler's ctx.speech.say is spoken verbatim after the reply it followed", async () => {
    const outcomes: Promise<SpeechOutcome>[] = [];
    const call = await liveCall({
      events: {
        "agentTranscript.committed": (event, ctx) => {
          if (event.text === GREETING) outcomes.push(ctx.speech.say("And one more thing.").done);
        },
      },
    });

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    await expect(outcomes[0]).resolves.toBe("played");
    expect(call.spoken()).toBe(`${GREETING}And one more thing.`);
    // Verbatim: no model turn produced it.
    expect(call.llm.calls).toHaveLength(0);
    call.connection.close();
  });

  test("a route reaches a LIVE call through ctx.speech(sessionId), and gets undefined otherwise", async () => {
    const outcomes: Promise<SpeechOutcome>[] = [];
    const call = await liveCall({
      greeting: "",
      routes: {
        "POST /announce": (req, ctx) => {
          const { sessionId } = req.body as { sessionId: string };
          const speech = ctx.speech(sessionId);
          if (speech === undefined) return routeResponse(404, { error: "No such call" });
          outcomes.push(speech.say("Your order has shipped.").done);
          return { queued: true };
        },
      },
    });
    const post = (sessionId: string) =>
      call.runtime.serveRoute?.({
        method: "POST",
        path: "/announce",
        query: {},
        body: { sessionId },
        signal: new AbortController().signal,
      });

    expect(await post("not-a-live-call")).toMatchObject({ status: 404 });
    expect(await post(call.sessionId)).toEqual({ status: 200, body: { queued: true } });
    await expect(outcomes[0]).resolves.toBe("played");
    expect(call.spoken()).toBe("Your order has shipped.");
    call.connection.close();
  });

  test("a handler may interrupt from INSIDE the reply's own report, and a later say still plays", async () => {
    const outcomes: Promise<SpeechOutcome>[] = [];
    let interrupted: boolean | undefined;
    const call = await liveCall({
      events: {
        // Fired synchronously from inside the greeting's caption, i.e. with the
        // transport mid-reply on the stack: the re-entrant case.
        "agentTranscript.committed": (event, ctx) => {
          if (event.text !== GREETING) return;
          interrupted = ctx.speech.interrupt();
          outcomes.push(ctx.speech.say("Sorry, one moment.").done);
        },
      },
    });

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(interrupted).toBe(true);
    await expect(outcomes[0]).resolves.toBe("played");
    expect(call.spoken()).toContain("Sorry, one moment.");
    call.connection.close();
  });

  test("a handle held past the call settles DROPPED rather than speaking into nothing", async () => {
    const held: { say?: (text: string) => Promise<SpeechOutcome> } = {};
    const call = await liveCall({
      greeting: "",
      events: {
        "session.configured": (_event, ctx) => {
          held.say = (text) => ctx.speech.say(text).done;
        },
      },
    });
    call.connection.close();
    await call.connection.ended;

    await expect(held.say?.("Too late.")).resolves.toBe("dropped");
    expect(call.spoken()).toBe("");
  });
});
