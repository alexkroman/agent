// Copyright 2026 the AAI authors. MIT license.
// One call's DECISION, in isolation. UNIT tier: the gate's only collaborators
// are a digest (a plain object), a catalogue (a `Map`) and two functions, which
// is what makes the whole of digest-gated completion assertable without a model
// or a session.
//
// `session.integration.test.ts` drives the same logic through the real bridge;
// this file is the one that pins each branch.

import { describe, expect, type Mock, test, vi } from "vitest";
import { consoleLogger } from "../runtime-config.ts";
import { ASK_USER, STATE_SUMMARY_ARG, TASK_DONE, TELL_USER } from "./channel.ts";
import { createDigestStore, type DigestStore } from "./digest.ts";
import { createGatedExecutor, type GatedExecutor } from "./gate.ts";
import type { ToolCatalogEntry } from "./view.ts";

const entry = (name: string, over: Partial<ToolCatalogEntry> = {}): [string, ToolCatalogEntry] => [
  name,
  { name, description: "d", mutates: false, completes: false, ...over },
];

const CATALOG = new Map<string, ToolCatalogEntry>([
  entry("look_up"),
  entry("change_address", { mutates: true }),
  entry("hand_off", { mutates: true, completes: true }),
  entry(TELL_USER),
  entry(ASK_USER),
  entry(TASK_DONE, { mutates: true, completes: true }),
]);

function harness(over: { completionGate?: boolean; runTool?: GatedExecutor } = {}): {
  gate: GatedExecutor;
  digest: DigestStore;
  injected: string[];
  runTool: Mock<GatedExecutor>;
} {
  const digest = createDigestStore();
  const injected: string[] = [];
  // `vi.fn<GatedExecutor>` rather than inferring from the implementation: an
  // inferred mock is not assignable to the option's type, and casting it there
  // would let the double drift from the contract it stands in for.
  const runTool = vi.fn<GatedExecutor>(
    over.runTool ?? ((): Promise<string> => Promise.resolve(JSON.stringify({ ok: true }))),
  );
  const gate = createGatedExecutor({
    digest,
    catalog: CATALOG,
    completionGate: over.completionGate ?? true,
    transport: () => ({ injectTurn: (i) => injected.push(i) }),
    runTool,
    logger: consoleLogger,
    sessionId: "s1",
  });
  return { gate, digest, injected, runTool };
}

const signal = (): AbortSignal => new AbortController().signal;

describe("step 1 — the digest argument", () => {
  test("is recorded and STRIPPED before the tool runs", () => {
    const h = harness();
    void h.gate("look_up", { id: "o1", [STATE_SUMMARY_ARG]: "Reading o1." }, signal());
    expect(h.runTool).toHaveBeenCalledWith("look_up", { id: "o1" }, expect.anything());
    expect(h.digest.read().summary).toBe("Reading o1.");
  });

  test("is recorded FIRST, so a failing call still grounds the fast tier", async () => {
    const h = harness({ runTool: () => Promise.reject(new Error("down")) });
    await h
      .gate("change_address", { to: "x", [STATE_SUMMARY_ARG]: "Attempting." }, signal())
      .catch(() => undefined);
    expect(h.digest.read().summary).toBe("Attempting.");
  });

  test("a call that omits it leaves the previous summary standing", async () => {
    const h = harness();
    await h.gate("look_up", { [STATE_SUMMARY_ARG]: "First." }, signal());
    await h.gate("look_up", {}, signal());
    expect(h.digest.read().summary).toBe("First.");
  });
});

describe("step 2 — a channel call is answered here", () => {
  test("tell_user injects and never reaches the agent's tools", async () => {
    const h = harness();
    const result = await h.gate(
      TELL_USER,
      { text: "It is queued.", [STATE_SUMMARY_ARG]: "…" },
      signal(),
    );
    expect(h.injected).toEqual(["Tell the customer, in your own words: It is queued."]);
    expect(JSON.parse(result)).toEqual({ delivered: true });
    expect(h.runTool).not.toHaveBeenCalled();
  });

  test("an EMPTY payload is not a channel call, so it falls through", async () => {
    // `channelEffectOf` answers `undefined`, and the fall-through is what makes
    // the refusal visible (an unknown tool) rather than an unprompted utterance
    // about nothing.
    const h = harness();
    await h.gate(TELL_USER, { text: "  " }, signal());
    expect(h.injected).toEqual([]);
    expect(h.runTool).toHaveBeenCalled();
  });
});

describe("step 3 — digest-gated completion", () => {
  test("a `completes` call is REFUSED while a mutation is in flight, and does not run", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      runTool: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("{}");
        }),
    });
    const pending = h.gate("change_address", { to: "x", [STATE_SUMMARY_ARG]: "…" }, signal());
    const refused = await h.gate("hand_off", { [STATE_SUMMARY_ARG]: "…" }, signal());

    expect(JSON.parse(refused).error).toContain("change_address is still outstanding");
    expect(h.runTool).toHaveBeenCalledTimes(1);
    release?.();
    await pending;
  });

  test("the framework's own task_done is not exempt", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      runTool: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("{}");
        }),
    });
    const pending = h.gate("change_address", { to: "x", [STATE_SUMMARY_ARG]: "…" }, signal());
    const refused = await h.gate(
      TASK_DONE,
      { result: "All set!", [STATE_SUMMARY_ARG]: "…" },
      signal(),
    );
    expect(JSON.parse(refused).error).toContain("still outstanding");
    expect(h.injected).toEqual([]);
    release?.();
    await pending;
  });

  test("a refused completion does not itself become outstanding work", async () => {
    // Checked BEFORE any entry is opened — otherwise the first refusal would
    // make every later one refuse too, for the rest of the call.
    let release: (() => void) | undefined;
    const h = harness({
      runTool: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("{}");
        }),
    });
    const pending = h.gate("change_address", { to: "x", [STATE_SUMMARY_ARG]: "…" }, signal());
    await h.gate("hand_off", { [STATE_SUMMARY_ARG]: "…" }, signal());
    expect(h.digest.unsettled().map((e) => e.tool)).toEqual(["change_address"]);
    release?.();
    await pending;
  });

  test("a SETTLED refusal or failure does NOT block completion", async () => {
    // `pending` is the only non-terminal state, deliberately: blocking forever
    // on a failed step would wedge a call with no way out, and the judgement
    // about one belongs to the slow tier, which sees it in the brief.
    const h = harness({ runTool: () => Promise.reject(new Error("down")) });
    await h
      .gate("change_address", { to: "x", [STATE_SUMMARY_ARG]: "…" }, signal())
      .catch(() => undefined);
    const allowed = await h.gate(
      TASK_DONE,
      { result: "Could not do it.", [STATE_SUMMARY_ARG]: "…" },
      signal(),
    );
    expect(JSON.parse(allowed)).toEqual({ delivered: true });
  });

  test("with the gate OFF nothing is refused", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      completionGate: false,
      runTool: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("{}");
        }),
    });
    const pending = h.gate("change_address", { to: "x", [STATE_SUMMARY_ARG]: "…" }, signal());
    const allowed = await h.gate(TASK_DONE, { result: "done", [STATE_SUMMARY_ARG]: "…" }, signal());
    expect(JSON.parse(allowed)).toEqual({ delivered: true });
    release?.();
    await pending;
  });
});

describe("step 4 — only a one-way step is tracked", () => {
  test("a READ leaves no entry", async () => {
    const h = harness();
    await h.gate("look_up", { [STATE_SUMMARY_ARG]: "…" }, signal());
    expect(h.digest.read().entries).toEqual([]);
  });

  test("an UNDECLARED tool is treated as a read", async () => {
    // Reported once per session by `session.ts` rather than guessed at here.
    const h = harness();
    await h.gate("never_declared", { [STATE_SUMMARY_ARG]: "…" }, signal());
    expect(h.digest.read().entries).toEqual([]);
  });

  test("a mutation opens and settles", async () => {
    const h = harness();
    await h.gate("change_address", { to: "x", [STATE_SUMMARY_ARG]: "…" }, signal());
    expect(h.digest.read().entries).toMatchObject([{ tool: "change_address", state: "done" }]);
  });

  test("a THROW settles as failed and RE-THROWS", async () => {
    const h = harness({ runTool: () => Promise.reject(new Error("the service is down")) });
    await expect(
      h.gate("change_address", { to: "x", [STATE_SUMMARY_ARG]: "…" }, signal()),
    ).rejects.toThrow("the service is down");
    expect(h.digest.unsettled()).toEqual([]);
    expect(h.digest.read().entries).toMatchObject([
      { state: "failed", note: "the service is down" },
    ]);
  });

  test("two mutations get DISTINCT entries", async () => {
    const h = harness();
    await h.gate("change_address", { to: "a", [STATE_SUMMARY_ARG]: "…" }, signal());
    await h.gate("change_address", { to: "b", [STATE_SUMMARY_ARG]: "…" }, signal());
    const ids = h.digest.read().entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });
});
