// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { normalizeAgentParams } from "./_author-conveniences.ts";
import { isRecord } from "./is-record.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import { sessionSlot } from "./session-slot.ts";
import { workflow } from "./workflow.ts";

const workflows = {
  run: workflow({ description: "d", run: () => ({ ok: true }) }),
};

/** A field of the normalized record, read without asserting the record's type. */
function field(normalized: unknown, key: string): unknown {
  if (!isRecord(normalized)) throw new Error("expected a normalized record");
  return normalized[key];
}

describe("normalizeAgentParams", () => {
  test("the normalization is idempotent, because toAgentConfig re-runs it over agent()'s output", () => {
    for (const fields of [
      { name: "t", mode: "text", temperature: 0.2 },
      { name: "s", mode: "s2s", s2s: assemblyAIS2s() },
      { name: "a", mode: "workflow-app", workflows },
      { name: "p", turnTaking: { maxSilenceMs: 4000, detection: "manual" } },
    ]) {
      const once = normalizeAgentParams(fields);
      expect(normalizeAgentParams(once)).toEqual(once);
    }
  });

  test("passes a non-record through untouched, for the schema to refuse", () => {
    expect(normalizeAgentParams("not a def")).toBe("not a def");
  });

  test("writes the resolved mode, defaulting to pipeline", () => {
    expect(field(normalizeAgentParams({ name: "p" }), "mode")).toBe("pipeline");
  });

  test("lowers a model-id string to an LLM descriptor, and a slash means the gateway", () => {
    expect(field(normalizeAgentParams({ name: "p", llm: "claude-x" }), "llm")).toMatchObject({
      kind: "assemblyai",
      options: { model: "claude-x" },
    });
    expect(field(normalizeAgentParams({ name: "p", llm: "openai/gpt-x" }), "llm")).toMatchObject({
      kind: "gateway",
      options: { model: "openai/gpt-x" },
    });
  });

  test("lowers the turnTaking silence window onto the default STT stage", () => {
    const normalized = normalizeAgentParams({
      name: "p",
      turnTaking: { minSilenceMs: 300, maxSilenceMs: 2000 },
    });
    // Nothing else was in the group, so it is dropped rather than left empty.
    expect(field(normalized, "turnTaking")).toBeUndefined();
    expect(field(normalized, "stt")).toMatchObject({ kind: "assemblyai" });
  });

  test("refuses a silence window beside an explicit stt, which owns its own", () => {
    expect(() =>
      normalizeAgentParams({
        name: "p",
        stt: { kind: "assemblyai", options: {} },
        turnTaking: { maxSilenceMs: 2000 },
      }),
    ).toThrow(/explicit `stt` descriptor owns its own end-of-turn window/);
  });

  test("refuses a silence value that is not a number", () => {
    expect(() => normalizeAgentParams({ name: "p", turnTaking: { maxSilenceMs: "2s" } })).toThrow(
      "`turnTaking.maxSilenceMs` must be a number of milliseconds.",
    );
  });

  test("keeps a collected syncState record, and refuses the authored forms", () => {
    const cart = sessionSlot("cart", () => ({ items: 0 }), { view: (c) => c });
    // A record keyed by slot name is what an earlier pass (or another SDK
    // copy's) produced: validated and handed back as it is.
    const record = { cart: cart.projected };
    expect(field(normalizeAgentParams({ name: "p", syncState: record }), "syncState")).toBe(record);
    // A projection or a list is the form `agent()` refuses, reaching this
    // boundary from a raw `export default {...}`.
    expect(() => normalizeAgentParams({ name: "p", syncState: cart.projected })).toThrow(
      /`syncState` is not authored/,
    );
    expect(() => normalizeAgentParams({ name: "p", syncState: [cart.projected] })).toThrow(
      /sync: true/,
    );
    expect(() =>
      normalizeAgentParams({ name: "p", syncState: { basket: cart.projected } }),
    ).toThrow(/`syncState.basket` is not that slot's own projection/);
  });
});
