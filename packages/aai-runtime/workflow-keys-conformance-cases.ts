// Copyright 2026 the AAI authors. MIT license.
/**
 * The {@link WorkflowKeyStore} contract, as a list of `test()` declarations over
 * one arm.
 *
 * `workflow-keys-conformance.ts` is the entry point and carries the argument for
 * the pattern, the arms, and the rules for a new case. This file is the shared
 * VOCABULARY every arm needs ({@link WorkflowKeyArm}, {@link workflowKeyIds})
 * plus the cases themselves. It is the leaf, for the same mechanical reason the
 * other two tables' leaves are: the entry module imports this one, so a helper
 * declared there and imported back would be a cycle.
 *
 * ## Two methods, and the interesting half is ABSENCE
 *
 * `record` and `lookup` are the whole interface, so the happy path is one case.
 * Everything else here is a question about something that is NOT there — an
 * unknown key, an unknown workflow, an empty key, a limit of zero, a run
 * recorded twice — because that is where all five of the journal's drifts and
 * session state's one lived, and it is where both of this contract's live too
 * (see "What the table found" in the entry module).
 *
 * ## A case owns a fresh WORKFLOW, not just a fresh key
 *
 * The Postgres arm shares ONE table across every case in a file, and a lookup is
 * keyed on the PAIR — so isolating on the key alone would leave two cases
 * sharing a workflow's rows. Every case therefore takes its workflow name AND
 * its run ids from {@link WorkflowKeyArm.uid}, which is also what makes the cases
 * safe to run twice in one process against a database that survived the first
 * run.
 *
 * @internal
 */

import { describe, expect, test } from "vitest";
import type { WorkflowKeyStore } from "./workflow-keys.ts";

/**
 * One store under test.
 *
 * `keys()` is called per case rather than once, so an arm may hand back a fresh
 * store or the one shared store its tier can afford without any case knowing
 * which.
 */
export type WorkflowKeyArm = {
  /** What the reporter calls this store. */
  label: string;
  /** The store one case runs against. */
  keys: () => WorkflowKeyStore;
  /** A fresh, collision-proof id per call — see the arm-independence rule above. */
  uid: () => string;
};

/**
 * A fresh id per call, unique across processes and across two runs of one file,
 * and **lexicographically ASCENDING in generation order**.
 *
 * The last property is load-bearing and is why the counter is zero-padded. A
 * real `runId` is a ULID, which sorts by generation time, and the Postgres
 * store's `order by created_at desc, run_id desc` leans on that for two runs
 * recorded in the same instant — so an id factory whose tenth id sorted BELOW
 * its ninth (`-10` against `-9`, which is what an unpadded counter gives) would
 * make the tiebreak disagree with insertion order and report a contract failure
 * for a fixture's spelling. `aai-server/workflow-keys.scenario.test.ts` mints
 * real ULID-shaped ids for the same reason, one layer down.
 *
 * The pid is in the PREFIX for the reason `CONFORMANCE_PREFIX` in
 * `aai-server/store-conformance.ts` puts it there; the timestamp is what makes a
 * re-run against a surviving database find none of its own earlier rows.
 */
export function workflowKeyIds(label: string): () => string {
  let n = 0;
  return () =>
    `wkey-${label}-${process.pid}-${Date.now().toString(36)}-${String(n++).padStart(6, "0")}`;
}

/**
 * Record several runs under one key, in order, oldest first.
 *
 * SERIALLY, never `Promise.all`: "the order they were started" is the whole
 * ordering contract, and the Postgres store stamps `created_at` with the
 * statement's own transaction time — so concurrent inserts would leave the
 * expected order up to the pool.
 */
async function recordAll(
  store: WorkflowKeyStore,
  workflow: string,
  key: string,
  runIds: readonly string[],
): Promise<void> {
  for (const runId of runIds) await store.record(workflow, key, runId);
}

/**
 * The whole contract.
 *
 * @internal
 */
export function workflowKeyConformanceCases(arm: WorkflowKeyArm): void {
  describe(`workflow-keys conformance: ${arm.label}`, () => {
    describe("a recorded run is reachable by its key", () => {
      test("record then lookup answers the run", async () => {
        // The case the whole feature exists for: a run outlives the session that
        // started it, so this is how the NEXT phone call finds it.
        const store = arm.keys();
        const [workflow, runId] = [arm.uid(), arm.uid()];
        await store.record(workflow, "+14155550123", runId);
        expect(await store.lookup(workflow, "+14155550123", 20)).toEqual([runId]);
      });

      test("several runs under one key come back NEWEST FIRST", async () => {
        // Stated by the interface ("newest first") and reached two completely
        // different ways: memory UNSHIFTS, Postgres sorts on
        // `created_at desc, run_id desc`. A store that answered in insertion
        // order would agree with both on a single run and disagree here, and the
        // caller wants the newest — "the run belonging to this caller" is the
        // one they are on the phone about.
        const store = arm.keys();
        const workflow = arm.uid();
        const started = [arm.uid(), arm.uid(), arm.uid()];
        await recordAll(store, workflow, "caller", started);
        expect(await store.lookup(workflow, "caller", 20)).toEqual([...started].reverse());
      });

      test("the limit keeps the NEWEST, not the first ones stored", async () => {
        // `slice(0, limit)` off a newest-first list and `limit $3` after an
        // `order by ... desc` agree — but a store that clamped BEFORE ordering
        // would hand back the oldest runs, which is the answer least useful to
        // every caller.
        const store = arm.keys();
        const workflow = arm.uid();
        const started = [arm.uid(), arm.uid(), arm.uid(), arm.uid()];
        await recordAll(store, workflow, "caller", started);
        expect(await store.lookup(workflow, "caller", 2)).toEqual(
          [...started].reverse().slice(0, 2),
        );
      });

      test("a limit above the stored count answers all of them", async () => {
        const store = arm.keys();
        const workflow = arm.uid();
        const started = [arm.uid(), arm.uid()];
        await recordAll(store, workflow, "caller", started);
        expect(await store.lookup(workflow, "caller", 100)).toHaveLength(2);
      });
    });

    describe("the absence matrix", () => {
      // Both of this contract's drifts were about a run recorded twice, and
      // every drift the two sibling tables found was an edge case about absence
      // — so the unknown, the empty and the zero each get a case rather than
      // being left to a happy path's edges.
      test("an unknown key answers an EMPTY array", async () => {
        // Never `undefined` and never a rejection: a caller with no prior run is
        // the ORDINARY case — it is every first call — and the tool above this
        // branches on the array being empty.
        const store = arm.keys();
        const answered = await store.lookup(arm.uid(), "nobody", 20);
        expect(Array.isArray(answered)).toBe(true);
        expect(answered).toEqual([]);
      });

      test("a known key under an unknown WORKFLOW answers empty", async () => {
        // The workflow is half the key, and it is the half that survives a
        // redeploy (a `workflowId` embeds the source path). A store keyed on the
        // key alone would pass every case above and leak here.
        const store = arm.keys();
        const workflow = arm.uid();
        await store.record(workflow, "caller", arm.uid());
        expect(await store.lookup(arm.uid(), "caller", 20)).toEqual([]);
      });

      test("a workflow that recorded a DIFFERENT key answers empty for this one", async () => {
        const store = arm.keys();
        const workflow = arm.uid();
        await store.record(workflow, "+14155550123", arm.uid());
        expect(await store.lookup(workflow, "+14155550199", 20)).toEqual([]);
      });

      test("an EMPTY key is a key, not absence", async () => {
        // `""` standing in for a missing value was one of the five drifts the
        // journal's table found, twice over, so it is asked rather than assumed.
        // Reachable: `StartOptions.key` is author-supplied, and the obvious
        // source for a voice agent — the caller's number — is empty for a
        // withheld caller ID. Both stores treat it as an ordinary key, and the
        // alternative (silently indexing every anonymous caller's run under one
        // bucket that then reads as absence) is the answer to avoid.
        const store = arm.keys();
        const [workflow, runId] = [arm.uid(), arm.uid()];
        await store.record(workflow, "", runId);
        expect(await store.lookup(workflow, "", 20)).toEqual([runId]);
      });

      test("a limit of ZERO answers an empty page, not everything", async () => {
        // `slice(0, 0)` and `limit 0` both answer nothing, and neither store
        // treats 0 as "unlimited" — which is the other plausible reading and
        // would turn a clamp bug above this seam into a full history scan.
        // `resolveFindLimit` floors a caller's 0 at 1, so this is the seam's own
        // behaviour under a limit that reaches it some other way.
        const store = arm.keys();
        const workflow = arm.uid();
        await store.record(workflow, "caller", arm.uid());
        expect(await store.lookup(workflow, "caller", 0)).toEqual([]);
      });
    });

    describe("recording is IDEMPOTENT per run id", () => {
      test("re-recording the same run under the same key does not FAIL", async () => {
        // What a retried `record` after a lost connection sends. It must not
        // surface in the tool call that already started the run.
        const store = arm.keys();
        const [workflow, runId] = [arm.uid(), arm.uid()];
        await store.record(workflow, "caller", runId);
        await expect(store.record(workflow, "caller", runId)).resolves.toBeUndefined();
      });

      test("re-recording the same run does not LIST it twice", async () => {
        // The half of "no-op" that a resolving retry hides, and the first of the
        // two drifts this table found. `on conflict (run_id) do nothing` keeps
        // one row; the memory store UNSHIFTED unconditionally, so a retried
        // record answered the same run twice from one lookup — and a caller
        // reading `runs[0]` and `runs[1]` as two conversations would resume the
        // same one twice. Memory is the side that was wrong; see
        // `createMemoryKeyStore`.
        const store = arm.keys();
        const [workflow, runId] = [arm.uid(), arm.uid()];
        await store.record(workflow, "caller", runId);
        await store.record(workflow, "caller", runId);
        expect(await store.lookup(workflow, "caller", 20)).toEqual([runId]);
      });

      test("a run recorded under a SECOND key keeps the first, and joins no other", async () => {
        // The second drift, and the sharper one: the run id is the PRIMARY KEY,
        // so `on conflict (run_id) do nothing` means the first key a run was
        // recorded under is the only one that ever finds it —
        // `aai-server/workflow-keys.scenario.test.ts` pins that against a real
        // server. The memory store indexed the run under BOTH, so a lookup on
        // the second key answered a run that was started for somebody else's.
        // Unreachable through `start()`, which records once; asserted anyway,
        // because "unreachable" is what the interface's next caller does not
        // know.
        const store = arm.keys();
        const [workflow, runId] = [arm.uid(), arm.uid()];
        await store.record(workflow, "first-key", runId);
        await store.record(workflow, "second-key", runId);
        expect(await store.lookup(workflow, "first-key", 20)).toEqual([runId]);
        expect(await store.lookup(workflow, "second-key", 20)).toEqual([]);
      });

      test("a re-record does not move a run's POSITION", async () => {
        // First-write-wins has to hold for the ORDER too: a retry arriving after
        // a later run must not promote the earlier run to newest, which is what
        // an upsert (or memory's unconditional unshift) does.
        const store = arm.keys();
        const workflow = arm.uid();
        const [older, newer] = [arm.uid(), arm.uid()];
        await recordAll(store, workflow, "caller", [older, newer]);
        await store.record(workflow, "caller", older);
        expect(await store.lookup(workflow, "caller", 20)).toEqual([newer, older]);
      });
    });

    describe("the index is keyed on the PAIR", () => {
      test("the same key under two workflows stays apart", async () => {
        // Two workflows sharing a caller's phone number must not see each
        // other's runs — and a name is what survives a redeploy, so this is the
        // keying an author actually gets.
        const store = arm.keys();
        const [left, right] = [arm.uid(), arm.uid()];
        const [leftRun, rightRun] = [arm.uid(), arm.uid()];
        await store.record(left, "+14155550000", leftRun);
        await store.record(right, "+14155550000", rightRun);
        expect(await store.lookup(left, "+14155550000", 20)).toEqual([leftRun]);
        expect(await store.lookup(right, "+14155550000", 20)).toEqual([rightRun]);
      });

      test("two keys under one workflow stay apart", async () => {
        const store = arm.keys();
        const workflow = arm.uid();
        const [mine, theirs] = [arm.uid(), arm.uid()];
        await store.record(workflow, "+14155550001", mine);
        await store.record(workflow, "+14155550002", theirs);
        expect(await store.lookup(workflow, "+14155550001", 20)).toEqual([mine]);
        expect(await store.lookup(workflow, "+14155550002", 20)).toEqual([theirs]);
      });

      test("a key is not unique, so two runs under one key both stand", async () => {
        // Deliberate, and the reason the Postgres table keys on `run_id` rather
        // than on the pair: `StartOptions.key`'s doc says a key may name several
        // runs, so a second `start` for the same caller must neither fail nor
        // replace the first. "The newest run for this caller" is a READ.
        const store = arm.keys();
        const workflow = arm.uid();
        const started = [arm.uid(), arm.uid()];
        await recordAll(store, workflow, "caller", started);
        expect(await store.lookup(workflow, "caller", 20)).toHaveLength(2);
      });

      test("a lookup does not CONSUME what it answers", async () => {
        // A correlation index is read once per call and the same run is looked
        // up on every subsequent one, so a read that emptied a bucket would
        // work exactly once per caller.
        const store = arm.keys();
        const [workflow, runId] = [arm.uid(), arm.uid()];
        await store.record(workflow, "caller", runId);
        expect(await store.lookup(workflow, "caller", 20)).toEqual([runId]);
        expect(await store.lookup(workflow, "caller", 20)).toEqual([runId]);
      });
    });
  });
}
