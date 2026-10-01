// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for a run's `label` (`StartOptions.label`), end to end on one store: the
 * normalization, then a REAL client over the in-process engine and the memory
 * journal, then the HTTP listing a page reads.
 *
 * Not the per-backend round trip — that is `journal/conformance-cases.ts`, which
 * runs against memory, the platform transport and (scenario tier) Postgres. What
 * this adds is that the label a TOOL passes reaches every read of the run: a
 * `get`, a keyed `find`, a `recent` listing and `GET /workflows/runs`.
 */

import { workflow } from "@alexkroman1/aai";
import { afterEach, describe, expect, test } from "vitest";
import { makeLogger } from "../_logger-test-utils.ts";
import { serve } from "./api/_test-utils.ts";
import { createWorkflowClient } from "./client.ts";
import { createInProcessWorkflowEngine } from "./in-process.ts";
import { createMemoryKeyStore } from "./keys.ts";
import { MAX_WORKFLOW_RUN_LABEL_CHARS, normalizeRunLabel } from "./run-label.ts";

describe("normalizeRunLabel", () => {
  test("keeps an ordinary label as written", () => {
    expect(normalizeRunLabel("call the plumber, due 5 PM")).toBe("call the plumber, due 5 PM");
  });

  test("turns control characters into spaces and trims", () => {
    // A newline in a label forges a second row in a CLI table or a log line.
    expect(normalizeRunLabel("  call\nthe\tplumber\u001b[2J  ")).toBe("call the plumber [2J");
  });

  test("an empty, blank or non-string label is NO label", () => {
    expect(normalizeRunLabel("")).toBeUndefined();
    expect(normalizeRunLabel(" \n\t ")).toBeUndefined();
    expect(normalizeRunLabel(42)).toBeUndefined();
    expect(normalizeRunLabel(undefined)).toBeUndefined();
  });

  test("cuts at the cap in code points, never inside a surrogate pair", () => {
    expect(normalizeRunLabel("x".repeat(500))).toHaveLength(MAX_WORKFLOW_RUN_LABEL_CHARS);
    // Every emoji is two UTF-16 units; a `slice` on units would leave half of
    // the last one, which Postgres refuses as invalid UTF-8.
    const cut = normalizeRunLabel("🔧".repeat(MAX_WORKFLOW_RUN_LABEL_CHARS + 5)) ?? "";
    expect(Array.from(cut)).toHaveLength(MAX_WORKFLOW_RUN_LABEL_CHARS);
    expect(cut.isWellFormed()).toBe(true);
  });
});

/** A client over a real engine and memory journal — the `aai dev` stack. */
function stack() {
  const logger = makeLogger();
  const workflows = { remind: workflow({ description: "remind", run: () => "done" }) };
  const engine = createInProcessWorkflowEngine({ workflows, logger });
  const client = createWorkflowClient({
    workflows,
    keys: createMemoryKeyStore(),
    wdk: engine,
    logger,
  });
  return { client, engine };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("a labelled run", () => {
  test("carries its label on get, find and recent", async () => {
    const { client, engine } = stack();
    const runId = await client.start("remind", {}, { key: "kitchen", label: " plumber\n5 PM " });
    expect(await client.get(runId)).toMatchObject({ runId, label: "plumber 5 PM" });
    expect(await client.find("remind", "kitchen")).toMatchObject([
      { runId, label: "plumber 5 PM" },
    ]);
    expect(await client.recent("remind")).toMatchObject([{ runId, label: "plumber 5 PM" }]);
    engine.stop();
  });

  test("a run started with no label, or a blank one, has no `label` key at all", async () => {
    const { client, engine } = stack();
    const bare = await client.start("remind", {});
    const blank = await client.start("remind", {}, { label: "   " });
    expect(await client.get(bare)).not.toHaveProperty("label");
    expect(await client.get(blank)).not.toHaveProperty("label");
    engine.stop();
  });

  test("GET /workflows/runs lists it with its label", async () => {
    const { client, engine } = stack();
    const runId = await client.start("remind", {}, { label: "call the plumber" });
    const harness = await serve({ engine: () => client });
    close = harness.close;
    const res = await fetch(`${harness.url}/workflows/runs?workflow=remind`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runs: [{ runId, label: "call the plumber" }] });
    engine.stop();
  });
});
