// Copyright 2026 the AAI authors. MIT license.
/**
 * `SttTurnMeta.inputPeakDbfs` off the AssemblyAI adapter: the loudest audio
 * the adapter SENT under a turn's words, on the service's own clock.
 */

import { describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import type { SttTurnMeta } from "../openers.ts";
import { fakeOf, openSessionWith } from "./_assemblyai-test-utils.ts";
import { type AssemblyAISession, openAssemblyAI } from "./assemblyai.ts";

vi.mock("assemblyai", async () => {
  const { assemblyAIModuleMock } = await import("./_assemblyai-test-utils.ts");
  return assemblyAIModuleMock();
});

const RATE = 16_000;
function tone(amplitude: number, ms: number): Int16Array {
  const out = new Int16Array((RATE * ms) / 1000);
  for (let i = 0; i < out.length; i++) out[i] = i % 2 === 0 ? amplitude : -amplitude;
  return out;
}
const dbfs = (rms: number): number => 20 * Math.log10(rms / 32_768);

async function metaFor(
  session: AssemblyAISession,
  words: { start: number; end: number }[] | undefined,
): Promise<SttTurnMeta | undefined> {
  let seen: SttTurnMeta | undefined;
  const off = session.on("partial", (_text, meta) => {
    seen = meta;
  });
  fakeOf(session)._fire("turn", {
    transcript: "hello there",
    end_of_turn: false,
    end_of_turn_confidence: 0,
    ...(words === undefined ? {} : { words }),
  });
  await flush();
  off();
  return seen;
}

describe("assemblyAIStt — inputPeakDbfs", () => {
  test("reports the loudest sent audio under the turn's words", async () => {
    const session = await openSessionWith(openAssemblyAI, { model: "universal-3-5-pro" });
    session.sendAudio(tone(500, 1000)); // 0-1000 ms
    session.sendAudio(tone(6000, 600)); // 1000-1600 ms
    session.sendAudio(tone(500, 1000)); // 1600-2600 ms

    const loud = await metaFor(session, [
      { start: 1100, end: 1300 },
      { start: 1300, end: 1500 },
    ]);
    expect(loud?.inputPeakDbfs).toBeCloseTo(dbfs(6000), 6);

    const quiet = await metaFor(session, [{ start: 1900, end: 2400 }]);
    expect(quiet?.inputPeakDbfs).toBeCloseTo(dbfs(500), 6);
  });

  test("omits it when the turn carries no word timings", async () => {
    const session = await openSessionWith(openAssemblyAI, { model: "universal-3-5-pro" });
    session.sendAudio(tone(6000, 1000));
    expect(await metaFor(session, undefined)).toEqual({ endOfTurnConfidence: 0 });
    expect(await metaFor(session, [])).toEqual({ endOfTurnConfidence: 0 });
  });

  test("a reconnected session measures on its own, restarted clock", async () => {
    const before = await openSessionWith(openAssemblyAI, { model: "universal-3-5-pro" });
    before.sendAudio(tone(8000, 2000));
    await before.close();
    // The new socket's word timestamps start from zero again; the loud audio
    // the old socket sent over the same milliseconds must not be found.
    const after = await openSessionWith(openAssemblyAI, { model: "universal-3-5-pro" });
    expect((await metaFor(after, [{ start: 500, end: 900 }]))?.inputPeakDbfs).toBeUndefined();
    after.sendAudio(tone(400, 2000));
    const meta = await metaFor(after, [{ start: 500, end: 900 }]);
    expect(meta?.inputPeakDbfs).toBeCloseTo(dbfs(400), 6);
  });
});
