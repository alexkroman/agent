// Copyright 2026 the AAI authors. MIT license.
/**
 * Inject a failure at every declared site and assert the FRAME and the
 * RECOVERY — `_error-injection-matrix.ts` is the table, this is what runs it.
 *
 * ## Why a table plus a driver, rather than a spec per failure
 *
 * There are specs per failure already, and they are good ones
 * (`pipeline-transport-error-phrase.test.ts` covers what the caller hears when
 * an LLM turn fails, `pipeline-stream.test.ts` the drain timeout). What none of
 * them can do is fail when a NINTH `SessionErrorCode` lands with no recovery
 * story, because each names its own code and no file enumerates the union at
 * the behaviour level. That gate is `unclassifiedCodes()`, and it is the reason
 * this suite exists; the drivers are what stop the table being a document
 * nothing runs.
 *
 * ## The recovery oracle is A SECOND TURN
 *
 * Asserting `fatal` alone would restate the matrix rather than test it — the
 * value is read off the frame and compared to the value the table declares,
 * which is one fact checked against itself. What `fatal` MEANS is whether the
 * conversation continues, so every `turn-recovered` row is driven twice: the
 * failure, then an ordinary user turn, which must still reach TTS. That is the
 * assertion the three shipped `fatal` bugs would each have failed — all of them
 * reported a session over while the transport went on inviting the next turn.
 *
 * A `terminated` row gets the mirror image: the adopted provider sessions must
 * be CLOSED. A session reported dead whose provider link is still open is the
 * `endSession` defect recorded in `packages/aai/CLAUDE.md` — billed, relaying,
 * and invisible to a client that has already hung up.
 */

import { PIPELINE_FLUSH_TIMEOUT_MS } from "@alexkroman1/aai/host-internal";
import { SessionErrorCodeSchema } from "@alexkroman1/aai/protocol";
import type { LanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import {
  CLIENT_MINTED_CODES,
  drivenHere,
  SESSION_ERROR_SITES,
  type SessionErrorSite,
  unclassifiedCodes,
} from "./_error-injection-matrix.ts";
import {
  createFailingSttProvider,
  createFailingTtsProvider,
  createFakeLanguageModel,
  createFakeTtsProvider,
} from "./_pipeline-test-fakes.ts";
import { makeOpts, useVirtualTime } from "./transports/_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./transports/pipeline-transport.ts";
import type { TransportEventBody } from "./transports/types.ts";

/**
 * The ONE arm of `LanguageModel` this fake really is.
 *
 * That type is a union over three provider spec versions plus a bare model-id
 * string, so a `doStream` wrapper written against the union has to satisfy V2,
 * V3 and V4 call options at once and satisfies none of them. `Extract` on the
 * discriminant the fake declares (`specificationVersion: "v3"`) is what makes
 * the override type-check — and it is the reason this is not the
 * `as unknown as` the two existing wrappers here reach for (`instrumentLlm`,
 * `llmCalls`), which the escape-hatch ratchet counts.
 */
type StreamingModel = Extract<LanguageModel, { specificationVersion: "v3" }>;

/** One reported session error, narrowed off the event union. */
type ErrorFrame = Extract<TransportEventBody, { type: "error.reported" }>;

useVirtualTime();

// ─── The gate ───────────────────────────────────────────────────────────────

describe("every session error code is classified", () => {
  /**
   * The sweep. A code is classified when some site row emits it, and otherwise
   * must be named in `CLIENT_MINTED_CODES` with a reason.
   *
   * Driven off `SessionErrorCodeSchema.options`, so this fails on the day a
   * code JOINS the union rather than on the day somebody notices.
   */
  test("no code is left without a site or a declaration", () => {
    expect(
      unclassifiedCodes(),
      "these codes are emitted by no declared site and are not declared client-minted. " +
        "Either add a row to SESSION_ERROR_SITES saying where the runtime emits one and " +
        "what the session does next, or add a CLIENT_MINTED_CODES entry saying why the " +
        "runtime never does. Silence is what every `fatal` bug in this family was.",
    ).toEqual([]);
  });

  /** Nothing in the declared map may be dead — an entry some row now emits. */
  test("no CLIENT_MINTED_CODES entry is stale", () => {
    const emitted = new Set<string>(SESSION_ERROR_SITES.map((s) => s.code));
    for (const [code, reason] of Object.entries(CLIENT_MINTED_CODES)) {
      expect(reason.length, `${code} needs a real reason`).toBeGreaterThan(30);
      expect(
        emitted.has(code),
        `${code} is now emitted by a declared site, so its CLIENT_MINTED_CODES entry says ` +
          "the opposite of what the runtime does. Remove it.",
      ).toBe(false);
    }
  });

  /**
   * A row that is not driven here has to name who drives it AND why this suite
   * cannot — the field exists because the failure mode of a table like this is
   * a row everybody believes and nothing runs.
   */
  test("every row that is not driven here names an owner and a reason", () => {
    for (const site of SESSION_ERROR_SITES) {
      if (site.driven === "here") continue;
      expect(site.driven.owner, `${site.site} needs an owner path`).toMatch(/^packages\//);
      expect(site.driven.why.length, `${site.site} needs a real reason`).toBeGreaterThan(40);
    }
  });

  /** Site ids are the driver table's keys, so a duplicate silently drops one. */
  test("site ids are unique", () => {
    const ids = SESSION_ERROR_SITES.map((s) => s.site);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The corpus floor. This whole suite's success output is a count, so a table
   * that emptied — a bad filter, a renamed export — would print the same green.
   */
  test("the table covers a corpus", () => {
    expect(SESSION_ERROR_SITES.length).toBeGreaterThan(10);
    expect(drivenHere().length).toBeGreaterThan(5);
    expect(SessionErrorCodeSchema.options.length).toBe(8);
  });
});

// ─── The drivers ────────────────────────────────────────────────────────────

/** What a driver hands back: the transport under test and its recorded frames. */
type Injection = {
  transport: ReturnType<typeof createPipelineTransport>;
  callbacks: ReturnType<typeof makeOpts>["callbacks"];
  tts: ReturnType<typeof createFakeTtsProvider>;
  stt: ReturnType<typeof makeOpts>["stt"];
  /** Drive one ordinary user turn — the recovery oracle. */
  say(text: string): void;
};

/**
 * A model whose `doStream` REFUSES the first `failures` requests.
 *
 * A separate code path from a scripted `error` stream part, and a separate row,
 * because it reaches BOTH reporters where the scripted part reaches one — see
 * the pinned finding at the foot of this file. The first draft of this comment
 * said it reached the outer catch "rather than" the stream-part handler, which
 * is what the module docs led one to expect and is not what happens.
 *
 * Spread rather than cast — the fake is a plain object closing over its own
 * state, so the override keeps every other method.
 */
function refusingLlm(failures: number): StreamingModel {
  const base = createFakeLanguageModel({ script: [{ type: "text", text: "I am here." }] });
  if (typeof base === "string" || base.specificationVersion !== "v3") {
    throw new Error("the fake model is a v3 object, never an id or another spec version");
  }
  let seen = 0;
  return {
    ...base,
    doStream: (opts: Parameters<StreamingModel["doStream"]>[0]) => {
      seen += 1;
      if (seen <= failures) return Promise.reject(new Error("provider refused the connection"));
      return base.doStream(opts);
    },
  };
}

/** A reply that always succeeds, for the turns AFTER an injected failure. */
const workingReply = (): LanguageModel =>
  createFakeLanguageModel({ script: [{ type: "text", text: "I am here." }], repeatLast: true });

/**
 * One driver per site driven here. Keyed by site id so the two lists are
 * checked against each other rather than kept in step by hand.
 */
const DRIVERS: Record<string, () => Promise<Injection>> = {
  "stt.open-rejected": async () => {
    const { opts, tts, callbacks, stt } = makeOpts({
      stt: createFailingSttProvider("stt_connect_failed", "STT: missing API key."),
      llm: workingReply(),
    });
    return await open(opts, { tts, callbacks, stt });
  },

  "tts.open-rejected": async () => {
    const { opts, tts, callbacks, stt } = makeOpts({
      tts: createFailingTtsProvider("tts_connect_failed", "TTS: missing API key."),
      llm: workingReply(),
    });
    return await open(opts, { tts, callbacks, stt });
  },

  "stt.stream-error": async () => {
    const { opts, tts, callbacks, stt } = makeOpts({ llm: workingReply() });
    const live = await open(opts, { tts, callbacks, stt });
    stt.last()?.fireError("stt_stream_error", "the transcript stream died");
    return live;
  },

  "tts.stream-error": async () => {
    const { opts, tts, callbacks, stt } = makeOpts({ llm: workingReply() });
    const live = await open(opts, { tts, callbacks, stt });
    tts.last()?.fireError("tts_stream_error", "the synthesis stream died");
    return live;
  },

  "llm.stream-error-part": async () => {
    // Two steps: the failing turn, then a working one. `repeatLast` is what
    // makes the recovery oracle reachable — without a second script the next
    // turn would fail for a reason the table never declared.
    const { opts, tts, callbacks, stt } = makeOpts({
      llm: createFakeLanguageModel({
        steps: [
          [{ type: "error", error: new Error("Internal Server Error") }],
          [{ type: "text", text: "I am here." }],
        ],
        repeatLast: true,
      }),
    });
    const live = await open(opts, { tts, callbacks, stt });
    live.say("are you there?");
    return live;
  },

  "llm.request-refused": async () => {
    const { opts, tts, callbacks, stt } = makeOpts({ llm: refusingLlm(1) });
    const live = await open(opts, { tts, callbacks, stt });
    live.say("are you there?");
    return live;
  },

  "tts.drain-timeout": async () => {
    // `autoDoneOnFlush: false` is the injection: the provider acknowledges no
    // flush, so the turn's drain runs out its own deadline rather than settling.
    const { opts, tts, callbacks, stt } = makeOpts(
      { llm: workingReply() },
      { tts: createFakeTtsProvider({ autoDoneOnFlush: false }) },
    );
    const live = await open(opts, { tts, callbacks, stt });
    live.say("are you there?");
    // A bare throw rather than an `expect`: an assertion outside a test body is
    // `noMisplacedAssertion`, and what this needs is a poll condition anyway —
    // the drain cannot time out before the flush it is waiting on was issued.
    await vi.waitFor(() => {
      if (tts.last()?.flush.mock.calls.length === 0) throw new Error("no flush issued yet");
    });
    await vi.advanceTimersByTimeAsync(PIPELINE_FLUSH_TIMEOUT_MS + 1000);
    return live;
  },
};

/** The driver for `id`, or a failure naming the row that has none. */
function driverFor(id: string): () => Promise<Injection> {
  const driver = DRIVERS[id];
  if (!driver) throw new Error(`no driver for site ${id}`);
  return driver;
}

/** Start a transport and wrap it in the {@link Injection} shape. */
async function open(
  opts: Parameters<typeof createPipelineTransport>[0],
  parts: Pick<Injection, "tts" | "callbacks" | "stt">,
): Promise<Injection> {
  const transport = createPipelineTransport(opts);
  // A provider open that fails resolves rather than rejecting, but the seam is
  // the caller's to guard: `start()` is not contracted to swallow every path.
  await transport.start().catch(() => undefined);
  return {
    transport,
    ...parts,
    say(text: string) {
      parts.stt.last()?.fireFinal(text);
    },
  };
}

/**
 * EVERY frame a site produced for `code`, not the first.
 *
 * The plural is load-bearing and was found by A/B rather than by design. One
 * refused LLM request reports TWICE — see the pinned finding at the foot of
 * this file — so a `.find()` here asserted on whichever reporter happened to
 * fire first and left the other free to say anything. Flipping
 * `pipeline-llm-stream.ts`'s `fatal` to `true` passed a green suite; against
 * the plural it fails, which is the whole difference between an oracle and a
 * restatement of the table.
 */
function framesFor(live: Injection, code: string): ErrorFrame[] {
  return live.callbacks.events.filter(
    (e): e is ErrorFrame => e.type === "error.reported" && e.code === code,
  );
}

describe("each declared site produces its declared frame and recovery", () => {
  test("every row driven here has a driver, and every driver a row", () => {
    const byName = (a: string, b: string): number => a.localeCompare(b);
    const rows = drivenHere()
      .map((s) => s.site)
      .sort(byName);
    expect(Object.keys(DRIVERS).sort(byName)).toEqual(rows);
  });

  test.each(drivenHere().map((s): [string, SessionErrorSite] => [s.site, s]))(
    "%s",
    async (id, site) => {
      const live = await driverFor(id)();

      // ── The frames ──
      await vi.waitFor(() => {
        expect(framesFor(live, site.code), `${id} reported no ${site.code} error`).not.toHaveLength(
          0,
        );
      });
      for (const frame of framesFor(live, site.code)) {
        expect(
          frame,
          `${id} is declared ${site.recovery}, so EVERY ${site.code} frame it reports must ` +
            `carry fatal: ${site.fatal}. A site with two reporters that disagree is a client ` +
            "rendering whichever arrived last.",
        ).toMatchObject({ code: site.code, fatal: site.fatal });
      }

      // ── The recovery ──
      if (site.recovery === "terminated") {
        // Every session adopted before the failure must be closed. A session
        // reported dead over a link still open is billed and still relaying.
        for (const session of [...live.stt.sessions, ...live.tts.sessions]) {
          expect(session.closed.value, `${id} left a provider session open`).toBe(true);
        }
      } else {
        // The conversation continues: an ordinary turn still reaches TTS. This
        // is the assertion the three shipped `fatal` bugs each failed.
        const before = live.tts.last()?.textChunks.length ?? 0;
        live.say("what about now?");
        await vi.waitFor(() => {
          expect(
            live.tts.last()?.textChunks.length ?? 0,
            `${id} is declared ${site.recovery}, but the next turn reached no TTS`,
          ).toBeGreaterThan(before);
        });
      }

      await live.transport.stop();
    },
  );
});

// ─── What the matrix found ──────────────────────────────────────────────────

/**
 * ONE refused LLM request reports TWO error frames, and the second is the
 * uninformative one.
 *
 * Found by A/B while checking this suite's own sensitivity, not by design.
 * Driving a `doStream` rejection — a gateway 500, an expired key, a refused
 * connection — produces, in order:
 *
 * ```text
 * error.reported  llm  "provider refused the connection"                 fatal:false
 * error.reported  llm  "No output generated. Check the stream for errors." fatal:false
 * ```
 *
 * The first is the stream-part handler (`pipeline-stream-parts.ts`), which sees
 * the AI SDK's conversion of the rejection into an `error` part. The second is
 * the outer catch in `consumeLlmStream` (`pipeline-llm-stream.ts`), which then
 * sees `streamText` throw `NoOutputGeneratedError` because the stream it was
 * consuming produced nothing. Neither reporter knows the other fired.
 *
 * **The caller is unaffected and the client is not.** `errorPhrase` is spoken
 * once — `runReply` asks the turn outcome, not the frame count — so nothing is
 * audibly wrong. But a client that renders the latest error into a banner shows
 * `No output generated. Check the stream for errors.`, a message about this
 * runtime's own plumbing, in place of the one naming the actual cause. That is
 * the message a user reports, and it sends whoever reads it to the wrong layer.
 *
 * Pinned as the CURRENT behaviour with the defect named, deliberately NOT
 * "fixed" here: suppressing the second report means deciding whether an
 * `errored()` handler should swallow a later throw, which is a change to what
 * `failed` means for every turn and belongs in its own diff. This test is what
 * makes that diff's effect visible.
 */
describe("a refused LLM request reports twice — a known defect", () => {
  test("the second frame is the derived message, not the cause", async () => {
    const live = await driverFor("llm.request-refused")();
    await vi.waitFor(() => {
      expect(framesFor(live, "llm").length).toBeGreaterThan(1);
    });
    const messages = live.callbacks.events
      .filter((e): e is ErrorFrame => e.type === "error.reported")
      .map((e) => e.message);
    expect(messages[0]).toContain("provider refused the connection");
    expect(
      messages[1],
      "if this no longer holds, the duplicate report was fixed — delete this test and " +
        "the finding above it rather than updating the expectation.",
    ).toContain("No output generated");
    await live.transport.stop();
  });
});
