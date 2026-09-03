// Copyright 2026 the AAI authors. MIT license.
/**
 * The two UNIT arms of the journal contract, plus the gate under the gate.
 *
 * - **memory**, the reference, unconditionally.
 * - **platform**, over a fake transport that decodes and encodes exactly what
 *   `aai-server/workflow-journal-handler.ts` does and delegates every SEMANTIC to
 *   the reference journal — storing the codec's TEXT the way the platform's
 *   `jsonb` columns do, so the codec runs only on the client side, which is
 *   where it really runs.
 *
 * The Postgres arm is `journal-conformance-postgres.scenario.test.ts`.
 *
 * ## What the platform arm CAN and CANNOT see
 *
 * It can see the codec, the shape of every request the client builds, and
 * whether the client READS an answer at all rather than assuming one — a
 * `closeHook` that returns `true` without looking, or an `appendStep` that hands
 * back the entry it sent instead of the stored one, both redden here (A/B'd).
 *
 * What it cannot see is a REFUSAL whose trigger the fake never produces. The
 * fake answers well-formed rows by construction, so loosening `toStep` to accept
 * any record — one of the five drifts a review found — leaves this file fully
 * green while failing two cases in `workflow-journal-platform.test.ts` (also
 * A/B'd). That file is where a malformed answer is the SUBJECT; this one is where
 * a correct answer's MEANING is. Neither replaces the other, and a case about an
 * unparseable reply does not belong in a table three backends have to satisfy.
 *
 * It CANNOT see the platform's own SQL, and that is deliberate rather than a
 * gap left open. A JS reimplementation of those statements would be a third
 * implementation of the contract, it would be the arm a reader trusts most
 * because of its label, and it could not represent a single bug the platform has
 * actually shipped — the argument `aai-server/store-conformance.ts` makes at
 * length against `createFakeSql`. The platform's SQL half is
 * `aai-server/platform-workflow-journal.scenario.test.ts`.
 *
 * One consequence used to be named here as a LIVE divergence, and it is worth
 * keeping as the worked example of what this arm cannot see rather than as a
 * standing bug report: `platform-workflow-journal.ts`'s `createRun` was
 * `on conflict (slug, run_id) do nothing` with no `returning`, so the platform
 * silently accepted a second start on an id the other two backends refuse —
 * "two racing starts on one id therefore both believed they had won and the
 * loser's `input` was discarded, on the platform arm only, i.e. for every
 * deployed agent". The fake is memory-backed and refused, so this file stayed
 * green throughout. It is FIXED — that store authors a
 * `PlatformWorkflowRunTakenError` off the `returning` now, and
 * `journal-conformance-platform.scenario.test.ts` is what holds it — and the
 * general form of the gap is unchanged: closing one of these for real means
 * running this same case list over `createPlatformJournal` wired to the real
 * handler and a real Postgres, which can only be done from `aai-server`.
 *
 * What is new is a second, cheaper way to state such a claim: model the shipped
 * behaviour as a decorator over the reference store
 * (`_workflow-defective-journal.ts`'s `silentDuplicateCreate`) and freeze an
 * interleaving that catches it (`workflow-interleavings/colliding-start.ts`).
 * That does not replace a real backend — it cannot tell you which backend HAS
 * the behaviour — but it does make "would anything have caught this" a question
 * with a millisecond-long answer.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import {
  JOURNAL_BACKENDS,
  type JournalArm,
  journalConformance,
  journalIds,
} from "./journal-conformance.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { createPlatformJournal } from "./workflow-journal-platform.ts";
import type { JournalStore, RunRecord, RunStatus, StepEntry } from "./workflow-journal-types.ts";
import { JournalConflictError } from "./workflow-journal-types.ts";

/* -------------------------------------------------------------------------- */
/* The memory arm                                                             */
/* -------------------------------------------------------------------------- */

const memoryIds = journalIds("mem");
const memoryStore = createMemoryJournal();

const memoryArm: JournalArm = {
  label: "memory",
  // ONE store across every case, exactly as the Postgres arm has to be. A fresh
  // store per case would let a case that leaks state pass here and fail there.
  journal: () => memoryStore,
  uid: memoryIds,
  /** The reference declares every method, `resumableRuns` included. */
  resumable: true,
};

journalConformance(memoryArm);

/* -------------------------------------------------------------------------- */
/* The platform arm, over a handler-shaped fake transport                     */
/* -------------------------------------------------------------------------- */

/** A request body, as the route parses it. */
type Body = Record<string, unknown>;

/** `requiredString`, as `_body-fields.ts` spells it. */
function str(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

/** `optionalString`: anything that is not a string is ABSENT, never coerced. */
function optStr(body: Body, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

/** `requiredInt`. */
function int(body: Body, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }
  return value;
}

/**
 * `optionalInt`, as `_body-fields.ts` spells it: absent or `null` means ABSENT,
 * and a present non-integer is a 400 rather than a coerced value.
 *
 * The fake has to make that distinction because `StepEntry.startedAt` is the
 * first optional NUMBER on this wire — `int` above would turn an absent one into
 * `NaN`, which is exactly the "invented answer" this arm exists to catch.
 */
function optInt(body: Body, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer when present`);
  }
  return value;
}

/** `optionalStrings`. */
function optStrs(body: Body, key: string): readonly string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map(String);
}

/** A stored value on its way back out: the platform's `text()` helper. */
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * One step as the ROUTE answers it, shared by the two step reads.
 *
 * One mapping, because the two reads differ only in how many rows they answer
 * and a field added to one is silently absent from the other — which is a drift
 * between the wire and the client's `toStep`, not between two backends, so the
 * conformance list itself cannot see it.
 */
const stepRow = (step: StepEntry): Record<string, unknown> => ({
  key: step.key,
  name: step.name,
  status: step.status,
  output: text(step.output),
  error: step.error?.message,
  attempts: step.attempts,
  startedAt: step.startedAt,
  finishedAt: step.finishedAt,
});

/**
 * The status, CHECKED — the route takes it as a plain string and the union is
 * the runtime's to police, so a fake that cast would be laxer than the wire.
 */
const RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];
function status(body: Body, key: string): RunStatus {
  const value = str(body, key);
  const found = RUN_STATUSES.find((s) => s === value);
  if (!found) throw new Error(`unknown status ${value}`);
  return found;
}

/** The `expect` list, checked member by member rather than cast wholesale. */
function statuses(body: Body, key: string): readonly RunStatus[] | undefined {
  return optStrs(body, key)?.flatMap((value) => {
    const found = RUN_STATUSES.find((s) => s === value);
    return found ? [found] : [];
  });
}

/**
 * The route's dispatch, over a reference journal that holds the codec's TEXT.
 *
 * Every arm of this switch mirrors `serve()` in
 * `aai-server/workflow-journal-handler.ts`: the same field parsing, the same
 * `?? null` on an absent answer, the same booleans and numbers. What it does NOT
 * mirror is the SQL below it — see this file's header for why.
 */
/**
 * One run on the wire, the shape `platform-workflow-journal.ts`'s `toRun` builds.
 *
 * ONE function for both read arms, because the real store has one and this fake
 * had the field list written out twice — so a field added to `getRun` and
 * forgotten in `listRuns` made this arm report a listing that drops it as green.
 * `codeVersion` was exactly that, caught by the conformance case that asserts
 * `listRuns` carries it.
 */
function runRow(run: RunRecord): Record<string, unknown> {
  return {
    runId: run.runId,
    workflow: run.workflow,
    status: run.status,
    createdAt: run.createdAt,
    input: text(run.input),
    output: text(run.output),
    error: run.error?.message,
    codeVersion: run.codeVersion,
  };
}

function serve(store: JournalStore, method: string, body: Body): Promise<unknown> {
  switch (method) {
    case "createRun":
      return store
        .createRun({
          runId: str(body, "runId"),
          workflow: str(body, "workflow"),
          status: status(body, "status"),
          createdAt: int(body, "createdAt"),
          // The ENCODED text, stored verbatim the way a `jsonb` column does. The
          // platform never sees a decoded value and this fake must not either.
          input: optStr(body, "input"),
          codeVersion: optStr(body, "codeVersion"),
        })
        .then(() => null);
    case "getRun":
      return store.getRun(str(body, "runId")).then((run) => (run ? runRow(run) : null));
    case "listRuns":
      return store
        .listRuns(str(body, "workflow"), int(body, "limit"))
        .then((runs) => runs.map(runRow));
    case "setStatus": {
      const error = optStr(body, "error");
      // The route always builds a patch object, and the statement under it
      // `coalesce`s — so a field the caller did not send cannot clear a stored
      // one. `omitUndefined` is what reproduces that here rather than handing the
      // reference journal a present-but-undefined key, which it reads as "clear".
      const patch = omitUndefined({
        output: optStr(body, "output"),
        error: error === undefined ? undefined : { message: error },
      });
      return store.setStatus(
        str(body, "runId"),
        status(body, "status"),
        patch,
        statuses(body, "expect"),
      );
    }
    case "readSteps":
      return store.readSteps(str(body, "runId")).then((steps) => steps.map(stepRow));
    case "readStep":
      // `null` and not `undefined` for the absent case, because this crosses
      // `JSON.stringify` — the real route answers the same way, and the client's
      // `toStep` reads either as "not settled".
      return store
        .readStep(str(body, "runId"), str(body, "key"))
        .then((step) => (step ? stepRow(step) : null));
    case "claimAttempt":
      return store.claimAttempt(str(body, "runId"), str(body, "key"));
    case "releaseAttempt":
      // `null` rather than `undefined`: the route answers JSON, and the client
      // reads nothing off it — see `releaseAttempt` in `workflow-journal-platform.ts`.
      return store.releaseAttempt(str(body, "runId"), str(body, "key")).then(() => null);
    case "readSleeps":
      return store.readSleeps(str(body, "runId")).then((records) =>
        records.map((record) => ({
          key: record.key,
          wakeAt: record.wakeAt,
          woken: record.woken,
          correlationId: record.correlationId,
          kind: record.kind,
        })),
      );
    case "claimSleep":
      return store
        .claimSleep(
          str(body, "runId"),
          str(body, "key"),
          int(body, "wakeAt"),
          optStr(body, "correlationId"),
          str(body, "kind") === "hookTimeout" ? "hookTimeout" : "sleep",
        )
        .then((record) => ({
          wakeAt: record.wakeAt,
          woken: record.woken,
          correlationId: record.correlationId,
          kind: record.kind,
        }));
    case "wakeSleeps":
      // `now` is read off the body the way the route reads it, and then the
      // reference journal's own clock decides — the one place this fake cannot
      // be faithful, since the memory backend takes no clock. That the client
      // SENDS it is pinned in `workflow-journal-platform.test.ts`.
      return Promise.resolve(int(body, "now")).then(() =>
        store.wakeSleeps(str(body, "runId"), optStrs(body, "correlationIds")),
      );
    case "claimHook":
      return store
        .claimHook(str(body, "runId"), str(body, "key"), str(body, "token"))
        .then((record) => ({
          token: record.token,
          delivered: record.delivered,
          payload: text(record.payload),
          closed: Boolean(record.closed),
        }));
    case "closeHook":
      return store.closeHook(str(body, "runId"), str(body, "key"));
    case "deliverHook":
      return store
        .deliverHook(str(body, "token"), optStr(body, "payload"))
        .then((runId) => runId ?? null);
    case "appendStep": {
      const row = body.entry;
      if (!isRecord(row)) throw new Error("entry must be an object");
      const failure = optStr(row, "error");
      return store
        .appendStep(str(body, "runId"), {
          key: str(row, "key"),
          name: str(row, "name"),
          status: str(row, "status") === "failed" ? "failed" : "ok",
          output: optStr(row, "output"),
          error: failure === undefined ? undefined : { message: failure },
          attempts: int(row, "attempts"),
          startedAt: optInt(row, "startedAt"),
          finishedAt: int(row, "finishedAt"),
        })
        .then((step) => ({
          key: step.key,
          name: step.name,
          status: step.status,
          output: text(step.output),
          error: step.error?.message,
          attempts: step.attempts,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
        }));
    }
    default:
      throw new Error("unknown workflow-journal method");
  }
}

/**
 * `createPlatformJournal` over the route above.
 *
 * The `fetch` seam is `PlatformEndpoint`'s own, so `platformResult` — the
 * envelope, the status check, the `{ result }` unwrapping — is production code
 * here rather than a fake's approximation.
 */
function platformJournalOver(store: JournalStore): JournalStore {
  const fetchFn: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    try {
      const result = await serve(store, String(body.method), body);
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err: unknown) {
      // **The STATUS is part of the contract now, and this used to flatten it.**
      // The comment here read "which status it is does not change that, so one
      // arm covers both" — true while the client's only behaviour for a non-2xx
      // was to propagate, and false since it began mapping a 409 to a
      // `JournalConflictError`: the engine reads that type to decide between
      // failing the run and retrying the delivery
      // (`workflow-replay-journal-failure.ts`). Answering 500 for a conflict
      // made this arm structurally unable to see the mapping — the typed-refusal
      // case failed here and passed everywhere else.
      //
      // So the fake mirrors the real route's `statusFor` hook: a refusal that is
      // a verdict about the RUN is a 409, everything else a 500.
      const conflict = JournalConflictError.is(err);
      return new Response(err instanceof Error ? err.message : "failed", {
        status: conflict ? 409 : 500,
      });
    }
  };
  return createPlatformJournal({
    base: "https://platform.test/conformance",
    token: "sandbox-token",
    fetch: fetchFn,
  });
}

const platformIds = journalIds("plat");
const platformStore = platformJournalOver(createMemoryJournal());

journalConformance({
  label: "platform (handler-shaped transport)",
  journal: () => platformStore,
  uid: platformIds,
  // `createPlatformJournal` deliberately omits `resumableRuns` — a deployed
  // guest's recovery is the platform queue's reconcile, and the omission is
  // pinned in `workflow-journal-platform.test.ts`. So the resume half is
  // EXCLUDED here and the reporter says so; it used to report ten green
  // checkmarks over ten empty bodies.
  resumable: false,
});

/* -------------------------------------------------------------------------- */
/* The gate under the gate                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A conformance table listing two of three arms reports the same green as one
 * listing all three, and a backend nobody registered reports nothing at all —
 * the silent-success shape `store-conformance-registry.test.ts` exists for one
 * package over. Everything here is a TEXT scan, for the same reason it is there:
 * a set comparison over declarations is not a pattern a line either matches or
 * does not, so it is a test rather than a `guard-invariants` rule.
 */
describe("the journal conformance registry", () => {
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

  test("every workflow-journal backend module in the tree is registered", () => {
    // Discovery is by FILENAME, which is what `konsistent.json`'s
    // `workflow-journal-backends` convention makes sound: it requires a
    // `workflow-journal-<backend>.ts` to export `create<Backend>Journal`, so a
    // fourth backend cannot arrive under a name this scan does not recognise.
    const modules = FILES.filter(
      (f) =>
        f.startsWith("workflow-journal-") && !isTest(f) && exportedFunctions(f).some(isFactory),
    );
    expect(modules.length).toBeGreaterThan(0);
    const registered = new Set(JOURNAL_BACKENDS.map((b) => b.module));
    expect(modules.filter((m) => !registered.has(m))).toEqual([]);
  });

  test("every registered factory really exists, in the module that claims it", () => {
    // A typo'd entry matches nothing and would otherwise pass, which is the
    // failure a registry is supposed to prevent rather than reproduce.
    const missing = JOURNAL_BACKENDS.filter(
      (b) => !exportedFunctions(b.module).includes(b.factory),
    ).map((b) => `${b.backend}: ${b.factory} in ${b.module}`);
    expect(missing).toEqual([]);
  });

  test("a non-conformable backend says WHY, and a conformable one does not", () => {
    for (const backend of JOURNAL_BACKENDS) {
      const exempt = backend.conformance === false;
      // An exemption with no reason is an omission wearing a decision's clothes.
      expect.soft(Boolean(backend.why), `${backend.backend} why`).toBe(exempt);
    }
  });

  test("every registered backend declares at least one arm", () => {
    // A case list constructed but never handed to `journalConformance`, or
    // handed to it from no file at all, looks identical to one that runs. What
    // this file can assert is that a backend CLAIMS an arm; whether the file it
    // names exists, invokes the list, builds that backend and sits in the tier
    // it declares is `journal-conformance-arms.test.ts`, which reads the whole
    // `packages/` tree because one of the four arms is a package away and no
    // scan of this directory could ever have seen it.
    for (const backend of JOURNAL_BACKENDS) {
      if (backend.conformance === false) continue;
      expect.soft(backend.arms.length, `${backend.backend} arms`).toBeGreaterThan(0);
    }
  });

  test("the case lists reach for no implementation of their own", () => {
    // A case list that imported a backend would be asserting against itself, and
    // the arm it was handed would be decoration. Comments are stripped first: the
    // modules' own docs NAME every backend at length, which is the trap
    // `store-conformance-registry.test.ts` and `check-escape-hatches.mjs`
    // both had to be taught.
    // The CASE modules only. The registry beside them names every factory as a
    // string by construction — that IS the registration — so it is not a case
    // list and is not scanned.
    for (const file of FILES.filter((f) => f.startsWith("journal-conformance-") && !isTest(f))) {
      const code = (READ.get(file) ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect.soft(code.split("\n").filter(isFactoryCall), file).toEqual([]);
    }
  });
});

/** `create<Something>Journal` — the name `konsistent.json` pins to the filename. */
function isFactory(name: string): boolean {
  return /^create[A-Z]\w*Journal$/.test(name);
}

/** A line that CALLS or IMPORTS one of those factories. */
function isFactoryCall(line: string): boolean {
  return /\bcreate[A-Z]\w*Journal\b/.test(line);
}
