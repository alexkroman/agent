// Copyright 2026 the AAI authors. MIT license.
/**
 * The two UNIT arms of the session-state contract, plus the gate under the gate.
 *
 * - **memory**, the reference, unconditionally.
 * - **platform**, over a fake transport that parses exactly what
 *   `aai-server/session-state-handler.ts` parses and delegates every SEMANTIC to
 *   the reference backend — so the codec runs only on the client side, which is
 *   where it really runs.
 *
 * The Postgres arm is `session-state-conformance-postgres.scenario.test.ts`.
 *
 * ## What the platform arm CAN and CANNOT see
 *
 * It can see every request the client builds and what it makes of a
 * well-formed answer: the `{ method, … }` body shape, the field parsing the
 * route really does, and the `event`/`json` rename in both directions. A/B'd —
 * reading `entry.json` instead of the wire's `entry.event` on the way in fails
 * 9 of these cases, and SENDING `json` instead of `event` fails 19.
 *
 * What it cannot see is a REFUSAL whose trigger the fake never produces. The
 * fake answers well-formed values by construction, so `countEvents`'
 * refusal — the one that must never default to 0, because a resumed session
 * restarting its log at 0 overwrites its own history — is invisible here:
 * replacing that `throw` with `return 0` leaves this file fully green and fails
 * four cases in `session-state-platform.test.ts` (also A/B'd). That file is
 * where a malformed answer is the SUBJECT; this one is where a correct answer's
 * MEANING is. Neither replaces the other.
 *
 * Nor can it see the platform's own SQL, and that is deliberate rather
 * than a gap left open. A JS reimplementation of those statements would be a
 * third implementation of the contract, it would be the arm a reader trusts most
 * because of its label, and it could not represent a single bug the platform has
 * actually shipped — the argument `aai-server/store-conformance.ts` makes at
 * length against `createFakeSql`. The journal's table proved the cost is real:
 * its `createRun` accepted a duplicate run id on the platform while the
 * equivalent fake-transport arm sat green, and only the same case list over the
 * REAL route and a real Postgres turned it red.
 *
 * Two live consequences, named because this arm reports both as green:
 *
 * - **`discard`'s reach.** The reference drops slots AND events, and so does
 *   `platform-session-state.ts`'s CTE — they agree by luck rather than by
 *   construction, so this arm would not notice the platform dropping one table.
 *   The Postgres arm is where the third answer lives (slots only), and the
 *   interface's own "not always both" is why no case asks.
 * - **`jsonb` normalization.** The fake stores the string it is handed, where
 *   the platform's columns re-serialize. The cases compare parsed values for
 *   that reason, so nothing here rests on it.
 *
 * **The FOURTH arm closes both, and it is built now**:
 * `aai-server/session-state-conformance-platform.scenario.test.ts` runs this
 * case list over the real route and a real database, reaching it through
 * `loadSessionStateConformance()` on `@alexkroman1/aai-runtime/internal` the way
 * the journal reaches its own. It asks the two questions above of the DATABASE
 * — `discard` really empties both tables, and a loaded value really is
 * re-serialized — and A/B'd the point of this section: a `discard` patched to
 * drop slots only leaves all 36 shared cases here GREEN and fails only that
 * arm's direct assertion. It also exercises one path no fake transport can
 * reach at all, `nextEventIndex`'s `bigint`-to-`Number` conversion, which
 * reddens six of these cases on the real arm when it is removed.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import {
  SESSION_STATE_BACKENDS,
  type SessionStateArm,
  sessionStateConformance,
  sessionStateIds,
} from "./session-state-conformance.ts";
import { createMemoryStateBackend } from "./session-state-memory.ts";
import { createPlatformStateBackend } from "./session-state-platform.ts";
import type { SessionStateBackend, StoredSessionEvent } from "./session-state-store.ts";

/* -------------------------------------------------------------------------- */
/* The memory arm                                                             */
/* -------------------------------------------------------------------------- */

// ONE backend across every case, exactly as the Postgres arm has to be. A fresh
// backend per case would let a case that leaks state pass here and fail there.
const memoryBackend = createMemoryStateBackend();

const memoryArm: SessionStateArm = {
  label: "memory",
  backend: () => memoryBackend,
  uid: sessionStateIds("mem"),
};

sessionStateConformance(memoryArm);

/* -------------------------------------------------------------------------- */
/* The platform arm, over a handler-shaped fake transport                     */
/* -------------------------------------------------------------------------- */

/** A request body, as the route parses it. */
type Body = Record<string, unknown>;

/** `requiredString`, as `aai-server/_body-fields.ts` spells it. */
function str(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") throw new Error(`${key} is required`);
  return value;
}

/** `requiredInt`: an integer of either sign, never a coercion. */
function int(body: Body, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
}

/** `slotMap`: `{ slot: value }`, every value a string, or a 400. */
function slotMap(body: Body): Map<string, string> {
  const values = body.values;
  if (!isRecord(values) || Object.values(values).some((v) => typeof v !== "string")) {
    throw new Error("values must be a map of strings");
  }
  return new Map(Object.entries(values).map(([slot, value]) => [slot, String(value)]));
}

/** `eventList`: each entry an integer index and a string, or a 400. */
function eventList(body: Body): StoredSessionEvent[] {
  const events = body.events;
  if (!Array.isArray(events)) throw new Error("events must be an array");
  return events.map((entry) => {
    if (!isRecord(entry) || typeof entry.event !== "string" || !Number.isInteger(entry.index)) {
      throw new Error("each event needs an integer index and a string");
    }
    return { index: Number(entry.index), json: entry.event };
  });
}

/**
 * The route's dispatch, over a reference backend.
 *
 * Every arm mirrors `serve()` in `aai-server/session-state-handler.ts`: the same
 * field parsing, the same `null` for a method that answers nothing, the same
 * `{ slot: value }` object rather than a `Map` on the way out, and the same
 * early return for an empty commit or append that `platform-session-state.ts`
 * makes before it issues SQL. What it does NOT mirror is the SQL below it — see
 * this file's header for why.
 */
async function serve(backend: SessionStateBackend, method: string, body: Body): Promise<unknown> {
  const sessionId = str(body, "sessionId");
  switch (method) {
    case "load": {
      const stored = await backend.load(sessionId);
      // A plain object, and only the string values — `loadSlots` builds its
      // record the same way, which is what the client's `toSlotMap` mirrors.
      return Object.fromEntries(stored);
    }
    case "commit": {
      const values = slotMap(body);
      if (values.size > 0) await backend.commit(sessionId, values);
      return null;
    }
    case "discard":
      await backend.discard(sessionId);
      return null;
    case "appendEvents": {
      const events = eventList(body);
      if (events.length > 0) await backend.appendEvents(sessionId, events);
      return null;
    }
    case "readEvents": {
      const events = await backend.readEvents(
        sessionId,
        int(body, "startIndex"),
        int(body, "limit"),
      );
      // The wire calls it `event`, matching the platform's column; the runtime
      // calls it `json`. The rename is the codec, and it is what this arm is for.
      return events.map((e) => ({ index: e.index, event: e.json }));
    }
    case "countEvents":
      return backend.countEvents(sessionId);
    default:
      throw new Error("unknown session-state method");
  }
}

/**
 * `createPlatformStateBackend` over the route above.
 *
 * The `fetch` seam is `PlatformEndpoint`'s own, so `platformResult` — the
 * envelope, the status check, the `{ result }` unwrapping — is production code
 * here rather than a fake's approximation.
 */
function platformBackendOver(backend: SessionStateBackend): SessionStateBackend {
  const fetchFn: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    try {
      const result = await serve(backend, String(body.method), body);
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err: unknown) {
      // Everything the route cannot serve is a 4xx or a 5xx, and the client's
      // only correct behaviour for either is to propagate. Which status it is
      // does not change that, so one arm covers both.
      return new Response(err instanceof Error ? err.message : "failed", { status: 500 });
    }
  };
  return createPlatformStateBackend({
    base: "https://platform.test/conformance",
    token: "sandbox-token",
    fetch: fetchFn,
  });
}

const platformBackend = platformBackendOver(createMemoryStateBackend());

sessionStateConformance({
  label: "platform (handler-shaped transport)",
  backend: () => platformBackend,
  uid: sessionStateIds("plat"),
});

/* -------------------------------------------------------------------------- */
/* The gate under the gate                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A conformance table listing two of three arms reports the same green as one
 * listing all three, and a backend nobody registered reports nothing at all —
 * the silent-success shape `store-conformance-registry.test.ts` exists for one
 * package over, and `journal-conformance.test.ts` beside this one. Everything
 * here is a TEXT scan, for the same reason it is there: a set comparison over
 * declarations is not a pattern a line either matches or does not, so it is a
 * test rather than a `guard-invariants` rule.
 */
describe("the session-state conformance registry", () => {
  const HERE = import.meta.dirname;
  const FILES = readdirSync(HERE).filter((f) => f.endsWith(".ts"));
  const READ = new Map(FILES.map((f) => [f, readFileSync(path.join(HERE, f), "utf-8")]));
  const isTest = (file: string) => /\.test(-d)?\.ts$/.test(file);

  /** `export function foo` in one module. */
  function exportedFunctions(file: string): string[] {
    const source = READ.get(file) ?? "";
    return [...source.matchAll(/^export (?:async )?function ([A-Za-z_$][\w$]*)/gm)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
  }

  test("every session-state backend in the tree is registered", () => {
    // Discovery is by FACTORY NAME rather than by filename, which is the one
    // difference from the journal's sweep and is deliberate: the three factories
    // do not all live in a `session-state-<backend>.ts` — the memory one is
    // re-exported from the module that declares the interface — so a filename
    // scan would have to know about that exception, while a name scan finds a
    // declaration wherever it sits. `konsistent.json`'s `session-state-backends`
    // convention is what keeps the name derivable in the other direction: a new
    // `session-state-<x>.ts` must export `create<X>StateBackend`, so a fourth
    // backend cannot arrive under a name this scan does not recognise.
    const declaring = FILES.filter((f) => !isTest(f) && exportedFunctions(f).some(isFactory));
    expect(declaring.length).toBeGreaterThan(0);
    const registered = new Set(SESSION_STATE_BACKENDS.map((b) => b.module));
    expect(declaring.filter((m) => !registered.has(m))).toEqual([]);
  });

  test("every registered factory really exists, in the module that claims it", () => {
    // A typo'd entry matches nothing and would otherwise pass, which is the
    // failure a registry is supposed to prevent rather than reproduce.
    const missing = SESSION_STATE_BACKENDS.filter(
      (b) => !exportedFunctions(b.module).includes(b.factory),
    ).map((b) => `${b.backend}: ${b.factory} in ${b.module}`);
    expect(missing).toEqual([]);
  });

  test("a non-conformable backend says WHY, and a conformable one does not", () => {
    for (const backend of SESSION_STATE_BACKENDS) {
      const exempt = backend.conformance === false;
      // An exemption with no reason is an omission wearing a decision's clothes.
      expect.soft(Boolean(backend.why), `${backend.backend} why`).toBe(exempt);
    }
  });

  test("every registered backend's arm really runs the case list, in its own tier", () => {
    // The assertion the whole exercise is about. A case list constructed but
    // never handed to `sessionStateConformance`, or handed to it from no file at
    // all, looks identical to one that runs.
    const armFiles = [...READ].filter(([, source]) => source.includes("sessionStateConformance("));
    expect(armFiles.length).toBeGreaterThan(0);
    for (const backend of SESSION_STATE_BACKENDS) {
      if (backend.conformance === false) continue;
      const want = backend.tier === "scenario";
      const found = armFiles.some(
        ([file, source]) =>
          /\.scenario\.test\.ts$/.test(file) === want && source.includes(`${backend.factory}(`),
      );
      expect.soft(found, `${backend.backend} arm in the ${backend.tier} tier`).toBe(true);
    }
  });

  test("the case lists reach for no implementation of their own", () => {
    // A case list that imported a backend would be asserting against itself,
    // and the arm it was handed would be decoration. Comments are stripped
    // first: the modules' own docs NAME every backend at length, which is the
    // trap `store-conformance-registry.test.ts` and `check-escape-hatches.mjs`
    // both had to be taught.
    //
    // The CASE modules only. The registry beside them names every factory as a
    // string by construction — that IS the registration — so it is not a case
    // list and is not scanned.
    const cases = FILES.filter(
      (f) => f.startsWith("session-state-conformance-") && !isTest(f) && !f.includes("scenario"),
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const file of cases) {
      const code = (READ.get(file) ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect.soft(code.split("\n").filter(isFactoryCall), file).toEqual([]);
    }
  });
});

/** `create<Something>StateBackend` — the name `konsistent.json` pins to the filename. */
function isFactory(name: string): boolean {
  return /^create[A-Z]\w*StateBackend$/.test(name);
}

/** A line that CALLS or IMPORTS one of those factories. */
function isFactoryCall(line: string): boolean {
  return /\bcreate[A-Z]\w*StateBackend\b/.test(line);
}
