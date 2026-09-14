// Copyright 2026 the AAI authors. MIT license.
/**
 * The three ASR-steering parameters this adapter dials beyond the endpointing
 * pair — `keyterms_prompt`, `agent_context` from the descriptor, and
 * `format_turns` — plus the mid-stream keyterm update.
 *
 * Its own file rather than a block in `assemblyai-connect-params.test.ts`:
 * that suite was written around "a default that stops reaching the wire is
 * invisible", and these are the opposite case — parameters an author has to
 * ASK for, each of which is silently ignored by the service on some model. The
 * failure they guard is a knob that appears to be set and is not.
 */

import { type AssemblyAISttOptions, assemblyAIStt } from "@alexkroman1/aai/stt";
import { describe, expect, test, vi } from "vitest";
import { fakeOf, openSessionWith } from "./_assemblyai-test-utils.ts";
import { type AssemblyAISession, openAssemblyAI } from "./assemblyai.ts";

vi.mock("assemblyai", async () => {
  const { assemblyAIModuleMock } = await import("./_assemblyai-test-utils.ts");
  return assemblyAIModuleMock();
});

async function openSession(
  providerOpts: AssemblyAISttOptions,
  openOpts: Partial<Parameters<ReturnType<typeof openAssemblyAI>["open"]>[0]> = {},
): Promise<AssemblyAISession> {
  return openSessionWith(openAssemblyAI, providerOpts, openOpts);
}

describe("assemblyAIStt STT adapter — formatTurns", () => {
  test("unset sends nothing, leaving the model's own behaviour", async () => {
    const session = await openSession({ model: "universal-streaming-english" });
    expect("formatTurns" in fakeOf(session).params).toBe(false);
    await session.close();
  });

  test("reaches the wire on a model where it IS a parameter", async () => {
    const on = await openSession({ model: "universal-streaming-english", formatTurns: true });
    expect(fakeOf(on).params.formatTurns).toBe(true);
    await on.close();

    // `false` must survive as false rather than being read as "unset".
    const off = await openSession({ model: "universal-streaming-english", formatTurns: false });
    expect(fakeOf(off).params.formatTurns).toBe(false);
    await off.close();
  });

  test("is NOT sent on universal-3-5-pro, and says so", async () => {
    // Formatting is always on there and `format_turns` is not a parameter, so
    // sending it would be a request the service ignores — and an author who
    // asked for `false` would believe they had turned formatting off.
    //
    // The spy has to be installed BEFORE the module loads: `consoleLogger`
    // binds `console.warn` when it is constructed, so a spy installed
    // afterwards never sees the call. Same trick the AAI_DEBUG trace test
    // uses, and the reason `openSessionWith` takes the opener as an argument.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    const fresh = await import("./assemblyai.ts");
    const session = await openSessionWith(fresh.openAssemblyAI, {
      model: "universal-3-5-pro",
      formatTurns: false,
    });
    expect("formatTurns" in fakeOf(session).params).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("universal-3-5-pro"),
    );
    warn.mockRestore();
    await session.close();
  });

  test("with formatting on, only the FORMATTED final commits", async () => {
    const session = await openSession({ model: "universal-streaming-english", formatTurns: true });
    const fake = fakeOf(session);
    const seen: { kind: string; text: string }[] = [];
    session.on("partial", (text) => seen.push({ kind: "partial", text }));
    session.on("final", (text) => seen.push({ kind: "final", text }));

    // The service sends two end_of_turn messages for one turn. Treating both
    // as finals would answer the same sentence twice.
    fake._fire("turn", {
      type: "Turn",
      turn_order: 1,
      end_of_turn: true,
      turn_is_formatted: false,
      transcript: "my number is nine seven two",
      words: [],
    });
    fake._fire("turn", {
      type: "Turn",
      turn_order: 1,
      end_of_turn: true,
      turn_is_formatted: true,
      transcript: "My number is 972.",
      words: [],
    });

    expect(seen).toEqual([
      { kind: "partial", text: "my number is nine seven two" },
      { kind: "final", text: "My number is 972." },
    ]);
    await session.close();
  });

  test("with formatting off, the single final commits as it always did", async () => {
    const session = await openSession({ model: "universal-streaming-english" });
    const fake = fakeOf(session);
    const finals: string[] = [];
    session.on("final", (text) => finals.push(text));
    fake._fire("turn", {
      type: "Turn",
      turn_order: 1,
      end_of_turn: true,
      turn_is_formatted: false,
      transcript: "my number is nine seven two",
      words: [],
    });
    expect(finals).toEqual(["my number is nine seven two"]);
    await session.close();
  });
});

describe("assemblyAIStt descriptor", () => {
  test("carries the steering options through as plain data", () => {
    const descriptor = assemblyAIStt({
      formatTurns: true,
    });
    expect(descriptor.options).toEqual({
      formatTurns: true,
    });
  });
});
