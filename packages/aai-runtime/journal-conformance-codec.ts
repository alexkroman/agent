// Copyright 2026 the AAI authors. MIT license.
/**
 * The {@link JournalStore} contract's CODEC half: which JavaScript values
 * survive being journaled — "did the run get back what the step returned".
 *
 * `journal-conformance.ts` is the entry point and carries the whole argument
 * for the pattern, the four arms and the rules for a new case. This file is the
 * third of its case modules, split off `journal-conformance-cases.ts` at the
 * seam that file already named — `values are TYPED JSON at every boundary` —
 * when it came within thirteen lines of the 500-line cap.
 *
 * **The seam is worth having for its own sake, not only for the cap.** Every
 * other case in the table is about a STATEMENT the backend issues: an
 * `on conflict`, a compare-and-set, a row count, an ordering. These are about
 * `workflow-typed-json.ts`, which sits between the engine and all three
 * backends, and they are the only cases in the table whose subject is neither
 * the interface nor the SQL. Every defect they cover is also SILENT in the same
 * particular way: `JSON.stringify` answers an index map for a `Uint8Array`, an
 * ISO string for a `Date` and `{}` for a `Map`, each with nothing raised, so a
 * resumed run reads garbage rather than failing.
 *
 * **The claim is about MEANING, never bytes**, which is why every case compares
 * with `toEqual` over a decoded value. Two of the four arms store `jsonb`,
 * which NORMALIZES — key order and number spelling are the database's to
 * choose — while the memory reference preserves the object it was handed. A
 * case that asserted a wire form would pass on one arm and fail on the others
 * while saying nothing about whether the value came back.
 *
 * @internal
 */

import { describe, expect, test } from "vitest";
import { type JournalArm, keysFor, runOf, stepOf } from "./journal-conformance-cases.ts";

/**
 * The typed-JSON half of the contract.
 *
 * @internal
 */
export function journalCodecConformance(arm: JournalArm): void {
  describe(`journal conformance (codec): ${arm.label}`, () => {
    describe("values are TYPED JSON at every boundary", () => {
      test("a Uint8Array and a Date survive a step's output", async () => {
        // `JSON.stringify` turns the first into an index map with NO error, so a
        // backend that reaches for it resumes the run with garbage rather than
        // failing. The codec is what carries them, and it has to run on every arm.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const output = { bytes: new Uint8Array([1, 2, 3]), at: new Date(1_700_000_000_000) };
        const stored = await journal.appendStep(runId, stepOf({ key: "render#0", output }));
        expect(stored.output).toEqual(output);
      });

      test("a run's input survives as typed JSON", async () => {
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        const input = { blob: new Uint8Array([9, 8]), when: new Date(1_700_000_000_001) };
        await journal.createRun(runOf({ runId, input }));
        expect((await journal.getRun(runId))?.input).toEqual(input);
      });

      test("a Map and a Set survive a step's output", async () => {
        // Both encode to `{}` under plain `JSON.stringify` — the same class of
        // silent loss as the two cases above, one type family over, and a worse
        // one: an index map at least still carries the bytes.
        //
        // Nested deliberately. The envelope entries are PAIRS, so the halves
        // recurse — a `Date` as a Map VALUE and bytes inside a `Set` are the
        // shapes that would break if either backend flattened the payload, and
        // no arm can see that from a one-level collection.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const output = {
          tags: new Set(["a", "b"]),
          byId: new Map<string, unknown>([
            ["r1", new Date(1_700_000_000_002)],
            ["r2", new Set([new Uint8Array([4, 5])])],
          ]),
        };
        const stored = await journal.appendStep(runId, stepOf({ key: "index#0", output }));
        expect(stored.output).toEqual(output);
      });

      test("a Map with a non-string KEY survives, which an object cannot express", async () => {
        // The case that distinguishes the envelope from `Object.fromEntries`:
        // stringifying the keys would turn this `Date` into an ISO string and
        // the bytes into `"6,7"`, and both losses are invisible in the answer.
        //
        // No ordering claim, and that is deliberate: `jsonb` normalizes, and an
        // insertion-order assertion would have to be verified on all four arms
        // to mean anything. `workflow-typed-json.test.ts` pins order on the unit
        // tier, where the wire is bytes.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        await journal.createRun(runOf({ runId }));
        const output = new Map<unknown, unknown>([
          [new Date(1_700_000_000_003), "dated"],
          [new Uint8Array([6, 7]), "keyed"],
        ]);
        const stored = await journal.appendStep(runId, stepOf({ key: "byKey#0", output }));
        expect(stored.output).toEqual(output);
      });

      test("an author's own envelope-shaped object is DATA, not a collection", async () => {
        // The trust-boundary half, over a real wire. A run's `input` arrives
        // from public HTTP, so an author's `{ __type: "Map", … }` becoming a
        // `Map` would be type confusion — and the escape that prevents it
        // renames a KEY, so this is also the case that proves the rename
        // survives whatever `jsonb` does to a key it does not understand.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        const input = { __type: "Map", entries: [["k", 1]], nested: { __type: "Set", values: [] } };
        await journal.createRun(runOf({ runId, input }));
        const stored = (await journal.getRun(runId))?.input;
        expect(stored).toEqual(input);
        expect(stored).not.toBeInstanceOf(Map);
      });

      test("a string PostgreSQL cannot store survives, on every arm", async () => {
        // The one case in this table whose failure was a 503 rather than a wrong
        // value. `input`, `output` and a step's `output` are `jsonb` on both
        // database arms, and `jsonb` refuses a NUL and an unpaired surrogate — so
        // the driver raised a raw SQLSTATE, `withReserved` answered a RETRYABLE
        // 503, and the engine spent the message's whole attempt budget on a value
        // that could never be accepted. The MEMORY arm holds JavaScript values
        // and took it happily, which is what made this `aai dev` works / deployed
        // fails: exactly the divergence this table exists to close, and it had no
        // case for it.
        //
        // The lone surrogate is the likelier half in real code — `"👋".slice(0,
        // 1)` is one, and so is any truncation of a transcript at a code UNIT
        // boundary rather than a code POINT one. Spelled as ESCAPES, because a
        // raw NUL makes a source file binary to `git grep`.
        const journal = arm.journal();
        const { runId } = keysFor(arm);
        const input = { note: "before\u0000after", "k\u0000ey": "\ud83d" };
        await journal.createRun(runOf({ runId, input }));
        expect((await journal.getRun(runId))?.input).toEqual(input);
        const output = { tail: "wave \ud83d", sentinel: "esc\u0001aped" };
        const stored = await journal.appendStep(runId, stepOf({ key: "nul#0", output }));
        expect(stored.output).toEqual(output);
      });
    });
  });
}
