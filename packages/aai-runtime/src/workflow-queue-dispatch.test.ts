// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the platform's queue-delivery door.
 *
 * The subject is the queue NAME. It used to be a CLASSIFICATION — the grammar
 * named a flow topic or a step topic and the door routed to one of the DevKit's
 * two callbacks — and what survives is narrower and still load-bearing: the name
 * is where the RUN ID comes from, and the platform's claim matches the same
 * grammar to serialize orchestration per run.
 *
 * `queueNameKind` outlives the routing it existed for because the platform's SQL
 * matches both patterns it exports. A step topic reaching this door can now only
 * be a DevKit-era message in flight across a deploy, and answering 400 retires it
 * rather than spending the whole abandonment budget on it first.
 */

import { describe, expect, test, vi } from "vitest";
import { deliverQueueMessage, queueNameKind } from "./workflow-queue-dispatch.ts";
// The park CADENCE is its own module, and its own spec — `workflow-queue-park.
// test.ts` owns the curve. What is asserted HERE is what the DOOR answers, which
// the curve's own tests cannot claim: the door is what reads the clock.
import {
  QUEUE_DELIVERY_BUSY_SECONDS,
  QUEUE_DELIVERY_LONG_WALK_SECONDS,
} from "./workflow-queue-park.ts";

describe("queueNameKind", () => {
  // The grammar is `__[<namespace>_]wkf_(workflow|step)_<id>` — `parseQueueName`
  // in `@workflow/world`. Both namespaced spellings are real: the DevKit reads
  // `WORKFLOW_QUEUE_NAMESPACE`, so a deployment that sets one produces the
  // longer form and a classifier that only knew the short one would answer 400
  // for every message.
  test.each([
    ["__wkf_workflow_run_01H", "workflow"],
    ["__wkf_step_run_01H:step_3", "step"],
    ["__aai_wkf_workflow_r1", "workflow"],
    ["__aai_wkf_step_r1", "step"],
    ["__ns2_wkf_step_r1", "step"],
  ] as const)("classifies %s as %s", (name, kind) => {
    expect(queueNameKind(name)).toBe(kind);
  });

  test.each([
    // No id after the prefix — the prefix alone names no message.
    "__wkf_workflow_",
    "__wkf_step_",
    // Neither kind.
    "__wkf_hook_r1",
    // A namespace must start with a letter, per the DevKit's own pattern.
    "__2ns_wkf_step_r1",
    // Not the prefix at all — including the shape a caller might invent.
    "workflow_r1",
    "step",
    "",
    // Uppercase: the DevKit's pattern is lowercase-only, and accepting this
    // would mean two spellings of one queue.
    "__WKF_WORKFLOW_r1",
  ])("refuses to classify %s", (name) => {
    expect(queueNameKind(name)).toBeUndefined();
  });

  test("an absent header is not a queue name", () => {
    expect(queueNameKind(null)).toBeUndefined();
  });
});

describe("deliverQueueMessage", () => {
  const QUEUE_NAME_HEADER = "x-vqs-queue-name";

  const post = (queueName?: string) =>
    new Request("http://guest.local/workflow-queue", {
      method: "POST",
      headers: queueName === undefined ? {} : { [QUEUE_NAME_HEADER]: queueName },
      body: JSON.stringify({ runId: "from-payload" }),
    });

  test("re-walks the run the queue NAME names", async () => {
    // This is the whole door under the replay engine. A deployed guest's own
    // timers die with a sandbox that self-exits, so the platform's queue holds the
    // schedule and a due message boots the guest and arrives here.
    const deliver = vi.fn(async () => "completed");
    const res = await deliverQueueMessage(deliver, post("__wkf_workflow_wrun_7"));
    expect(res.status).toBe(200);
    expect(deliver).toHaveBeenCalledWith("wrun_7");
  });

  test("reads the name and NOT the payload, even when the payload carries an id", async () => {
    // The name is the field the platform's claim routes by and the one this engine
    // composed. A payload fallback was tried and removed: it couples this door to
    // the sending client for a case that cannot arise.
    const deliver = vi.fn(async () => undefined);
    await deliverQueueMessage(deliver, post("__wkf_workflow_wrun_7"));
    expect(deliver).toHaveBeenCalledWith("wrun_7");
    expect(deliver).not.toHaveBeenCalledWith("from-payload");
  });

  test("tolerates a namespaced name, which is the same grammar", async () => {
    const deliver = vi.fn(async () => undefined);
    await deliverQueueMessage(deliver, post("__acme_wkf_workflow_wrun_7"));
    expect(deliver).toHaveBeenCalledWith("wrun_7");
  });

  test("answers 200 for a run that is still SUSPENDED", async () => {
    // The platform acks on a 200, and a run that suspended again has been fully
    // served. Reporting "still waiting" as anything but success would have the
    // queue retry a wait — and burn an attempt doing it.
    const deliver = vi.fn(async () => "running");
    expect((await deliverQueueMessage(deliver, post("__wkf_workflow_r1"))).status).toBe(200);
  });

  test.each([
    ["a STEP topic", "__wkf_step_r1"],
    ["an unrelated name", "orders"],
    ["an empty id", "__wkf_workflow_"],
    ["no header at all", undefined],
  ])("answers 400 for %s, rather than 500", async (_label, queueName) => {
    // 400 versus 500 is what the platform's abandonment budget rests on. A 400
    // says "do not retry, this can never route" — a message with no id will not
    // grow one. A 500 would spend the whole budget first and abandon it anyway,
    // several minutes later. A step topic is included deliberately: this engine
    // runs a step inline during the walk and never as its own message, so such a
    // name can only be a DevKit-era message still in flight across a deploy.
    const deliver = vi.fn(async () => undefined);
    const res = await deliverQueueMessage(deliver, post(queueName));
    expect(res.status).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("lets a replay failure REJECT, so the door answers 500 and the queue retries", async () => {
    // A guest that was up and could not finish is exactly the case a retry is
    // for, and `serveFetch` is what turns the rejection into the 500.
    const deliver = vi.fn(async () => {
      throw new Error("journal unreachable");
    });
    await expect(deliverQueueMessage(deliver, post("__wkf_workflow_r1"))).rejects.toThrow(
      /journal unreachable/,
    );
  });
});

/**
 * The door's own concurrency, which is a UNIT claim: `deliver` is injected, so
 * "does a second delivery walk this run" is answerable with no journal, no
 * engine and no database. The tier that owns the other half — whether an
 * overlapping walk re-executes steps — is the engine's, and its harness
 * (`workflow-concurrent-delivery.test.ts`) drives the engine directly.
 *
 * Run ids are distinct per test on purpose: the in-flight set is module-scope
 * (it is a fact about the PROCESS), so a shared id would couple these cases.
 */
describe("a run is walked once at a time", () => {
  const post = (queueName: string) =>
    new Request("http://guest.local/workflow-queue", {
      method: "POST",
      headers: { "x-vqs-queue-name": queueName },
    });

  test("PARKS a delivery whose run is already being walked, without walking it again", async () => {
    // The measured bug this exists for: `QUEUE_DELIVERY_TIMEOUT_MS` aborts the
    // platform's fetch at 60s, the abort closes the RESPONSE and not the walk,
    // and the redelivery ~61s later used to start a second concurrent walk —
    // which, because `replayRun` reads the journal once per walk, re-ran every
    // step of the run rather than only the slow one.
    const first = Promise.withResolvers<string>();
    const deliver = vi.fn(async () => await first.promise);

    const walking = deliverQueueMessage(deliver, post("__wkf_workflow_busy_1"));
    // The first delivery is inside `deliver` and has not answered.
    expect(deliver).toHaveBeenCalledTimes(1);

    const redelivery = await deliverQueueMessage(deliver, post("__wkf_workflow_busy_1"));
    // NOT walked a second time — that is the whole assertion.
    expect(deliver).toHaveBeenCalledTimes(1);
    // A park, which the platform reads as "bring this back later" and which
    // touches no attempt. 200 rather than a 5xx, because a busy run is not a
    // failed delivery and a 5xx would spend the message's retry budget.
    expect(redelivery.status).toBe(200);
    expect(await redelivery.json()).toEqual({ timeoutSeconds: QUEUE_DELIVERY_BUSY_SECONDS });

    first.resolve("completed");
    expect((await walking).status).toBe(200);
  });

  test("walks a DIFFERENT run while one is in flight, so the gate is per run", async () => {
    // The gate must not serialize the whole guest: one slug's guest serves every
    // run of that slug, and a fan-out of independent runs is the ordinary case.
    const first = Promise.withResolvers<string>();
    const deliver = vi.fn(async (runId: string) =>
      runId === "busy_2" ? await first.promise : "completed",
    );

    const walking = deliverQueueMessage(deliver, post("__wkf_workflow_busy_2"));
    const other = await deliverQueueMessage(deliver, post("__wkf_workflow_other_2"));

    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ ok: true });
    expect(deliver).toHaveBeenCalledWith("other_2");

    first.resolve("completed");
    await walking;
  });

  test("releases the run after the walk answers, so the next delivery walks it", async () => {
    const deliver = vi.fn(async () => "completed");
    expect((await deliverQueueMessage(deliver, post("__wkf_workflow_serial_3"))).status).toBe(200);
    expect(
      await (await deliverQueueMessage(deliver, post("__wkf_workflow_serial_3"))).json(),
    ).toEqual({ ok: true });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  test("releases the run after the walk THREW, so a retry is not wedged forever", async () => {
    // Without the `finally` this would be a permanent park: the door answers 500,
    // the platform retries, and every retry would be told the run is still busy
    // until the message was abandoned.
    const deliver = vi.fn(async () => {
      throw new Error("journal unreachable");
    });
    await expect(deliverQueueMessage(deliver, post("__wkf_workflow_threw_4"))).rejects.toThrow(
      /journal unreachable/,
    );

    await expect(deliverQueueMessage(deliver, post("__wkf_workflow_threw_4"))).rejects.toThrow(
      /journal unreachable/,
    );
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  test("an UNROUTABLE delivery reserves nothing, so it cannot park a live run", async () => {
    // The 400 is answered before the gate is consulted. A gate entry taken for a
    // message with no run id in it would be keyed on nothing.
    const deliver = vi.fn(async () => "completed");
    expect((await deliverQueueMessage(deliver, post("__wkf_step_r5"))).status).toBe(400);
    expect((await deliverQueueMessage(deliver, post("__wkf_workflow_r5"))).status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

/**
 * A parked delivery has to SAY SO, which for a long time it did not.
 *
 * The park is correct and it is silent, and silence is what a wedge looks like.
 * The measured case: a healthy 660.8 MB provider upload settled `ok` on its
 * first attempt after **3m21s** on one run and **15m00s** on the run before it,
 * and between the step's own opening line and the run finishing nothing was
 * emitted anywhere — not the guest log, not the run's event stream, not the
 * journal. Its author waited fourteen minutes, read the run as wedged, and
 * cancelled it 13 seconds before the upload landed.
 *
 * So the claim under test is not "does the door park" (above) but "can a reader
 * tell a slow run from a stuck one", and the answer is a DURATION. A park at 61s
 * is an ordinary slow step; a park at 900s is one an operator wants to know
 * about, and nothing but this line distinguishes them.
 */
describe("a park is reported, with how long the walk has been running", () => {
  const post = (queueName: string) =>
    new Request("http://guest.local/workflow-queue", {
      method: "POST",
      headers: { "x-vqs-queue-name": queueName },
    });

  /** The `Logger` shape is every level required — see `runtime-config.ts`. */
  const fakeLogger = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });

  test("names the run and the elapsed walk time", async () => {
    const first = Promise.withResolvers<string>();
    const deliver = vi.fn(async () => await first.promise);
    const logger = fakeLogger();

    // The clock is moved between the two calls so the reported duration is a
    // real subtraction rather than a zero that a hardcoded field would pass.
    // A `Date.now` spy rather than fake timers: there is no timer in this path
    // (the door awaits a promise), and `restoreMocks` undoes a spy for free
    // where `useFakeTimers` would owe a teardown.
    const base = 1_700_000_000_000;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(base)
      .mockReturnValue(base + 125_000);

    const walking = deliverQueueMessage(deliver, post("__wkf_workflow_report_1"), { logger });
    await deliverQueueMessage(deliver, post("__wkf_workflow_report_1"), { logger });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("parked"),
      expect.objectContaining({ runId: "report_1", walkingForSeconds: 125 }),
    );
    // Never `error`: nothing has failed. A run in this state is healthy, which
    // is the whole reason the line has to carry a number. Which LEVEL a park
    // takes is a function of the elapsed walk — 125s is under
    // `QUEUE_DELIVERY_LONG_WALK_SECONDS`, so this one is `info`; the escalation
    // is pinned in "a park asks to come back proportionately" below.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();

    first.resolve("completed");
    await walking;
  });

  test("says nothing when no delivery is parked, so a healthy run stays quiet", async () => {
    // A delivery is only ever re-presented after `QUEUE_DELIVERY_TIMEOUT_MS`
    // has closed the previous one's response, so the first park of any run is
    // ~61s into its walk and a healthy run parks ZERO times. That is what makes
    // a line per park affordable, and a line on the happy path would undo it.
    const deliver = vi.fn(async () => "completed");
    const logger = fakeLogger();
    await deliverQueueMessage(deliver, post("__wkf_workflow_quiet_2"), { logger });
    // EVERY level a reader sees, inlined at each site because `expect` inside a
    // helper trips Biome's `noMisplacedAssertion`. Naming only `warn` would pass
    // against a version that parked chattily at `info`, which — the level being
    // a function of the elapsed walk now — is the regression this guards.
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test("a walk that SETTLED parks nothing further, so the report cannot run forever", async () => {
    // The in-flight entry is what a park is answered from, so a leaked one is a
    // PERMANENT park — every later delivery told "still busy" for a walk that
    // ended, which is the silent-wedge shape this door's `finally` exists to
    // prevent. Asserted behaviourally rather than by exposing the map: "the
    // entry is gone" and "the next delivery WALKS" are the same claim, and only
    // one of them adds surface to `/internal`.
    const deliver = vi.fn(async () => "completed");
    const logger = fakeLogger();
    await deliverQueueMessage(deliver, post("__wkf_workflow_settled_3"), { logger });
    await deliverQueueMessage(deliver, post("__wkf_workflow_settled_3"), { logger });
    expect(deliver).toHaveBeenCalledTimes(2);
    // EVERY level a reader sees, inlined at each site because `expect` inside a
    // helper trips Biome's `noMisplacedAssertion`. Naming only `warn` would pass
    // against a version that parked chattily at `info`, which — the level being
    // a function of the elapsed walk now — is the regression this guards.
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test("a walk that THREW parks nothing further either", async () => {
    // The same invariant on the path that skips every non-`finally` cleanup.
    const deliver = vi.fn(async () => {
      throw new Error("journal unreachable");
    });
    const logger = fakeLogger();
    await expect(
      deliverQueueMessage(deliver, post("__wkf_workflow_threw_3"), { logger }),
    ).rejects.toThrow(/journal unreachable/);
    await expect(
      deliverQueueMessage(deliver, post("__wkf_workflow_threw_3"), { logger }),
    ).rejects.toThrow(/journal unreachable/);
    expect(deliver).toHaveBeenCalledTimes(2);
    // EVERY level a reader sees, inlined at each site because `expect` inside a
    // helper trips Biome's `noMisplacedAssertion`. Naming only `warn` would pass
    // against a version that parked chattily at `info`, which — the level being
    // a function of the elapsed walk now — is the regression this guards.
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test("a logger is optional, so a caller without one still parks correctly", async () => {
    const first = Promise.withResolvers<string>();
    const deliver = vi.fn(async () => await first.promise);
    const walking = deliverQueueMessage(deliver, post("__wkf_workflow_nolog_4"));
    const parked = await deliverQueueMessage(deliver, post("__wkf_workflow_nolog_4"));
    expect(await parked.json()).toEqual({ timeoutSeconds: QUEUE_DELIVERY_BUSY_SECONDS });
    first.resolve("completed");
    await walking;
  });
});

/**
 * What the DOOR answers, at both ends of the curve — the claim the unit tests
 * above cannot make, because the door is what reads the clock.
 */
describe("a park asks to come back proportionately", () => {
  const post = (queueName: string) =>
    new Request("http://guest.local/workflow-queue", {
      method: "POST",
      headers: { "x-vqs-queue-name": queueName },
    });

  const fakeLogger = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });

  /** Park one delivery with the clock `elapsedMs` past the walk's start. */
  const parkAt = async (
    runId: string,
    elapsedMs: number,
  ): Promise<{ body: unknown; logger: ReturnType<typeof fakeLogger> }> => {
    const first = Promise.withResolvers<string>();
    const deliver = vi.fn(async () => await first.promise);
    const logger = fakeLogger();
    const base = 1_700_000_000_000;
    // A `Date.now` spy rather than fake timers: there is no timer in this path,
    // and `restoreMocks` undoes a spy for free.
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(base)
      .mockReturnValue(base + elapsedMs);
    const walking = deliverQueueMessage(deliver, post(`__wkf_workflow_${runId}`), { logger });
    const parked = await deliverQueueMessage(deliver, post(`__wkf_workflow_${runId}`), { logger });
    const body: unknown = await parked.json();
    first.resolve("completed");
    await walking;
    return { body, logger };
  };

  test("a SHORT overlap gets the floor back, at info", async () => {
    const { body, logger } = await parkAt("curve_short", 2000);
    expect(body).toEqual({ timeoutSeconds: QUEUE_DELIVERY_BUSY_SECONDS });
    // `info`, not `warn`: a walk two seconds old is two deliveries racing.
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("parked"),
      expect.objectContaining({ walkingForSeconds: 2, retryInSeconds: 5 }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("the PRODUCTION case backs off, and is still only info", async () => {
    // 285 seconds in, where the flat version answered 5 and printed its ~45th
    // line. Under `QUEUE_DELIVERY_LONG_WALK_SECONDS`, so it is not yet a warn:
    // the threshold sits between the two measured healthy runs (3m21s nobody
    // minded, 15m00s its author cancelled).
    const { body, logger } = await parkAt("curve_long", 285_000);
    expect(body).toEqual({ timeoutSeconds: 36 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("parked"), {
      // The REPORTED retry is the one on the wire — two computations of one
      // curve is how they would drift.
      runId: "curve_long",
      walkingForSeconds: 285,
      retryInSeconds: 36,
    });
  });

  test("a walk past the long-walk threshold ESCALATES to warn", async () => {
    // The 15-minute upload. One line every ~2 minutes here, against 12 a
    // minute before.
    const { body, logger } = await parkAt("curve_warn", 900_000);
    expect(body).toEqual({ timeoutSeconds: 113 });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`over ${QUEUE_DELIVERY_LONG_WALK_SECONDS / 60} minutes`),
      { runId: "curve_warn", walkingForSeconds: 900, retryInSeconds: 113 },
    );
  });

  test("both lines share a prefix, so one grep finds a walk at either magnitude", async () => {
    const short = await parkAt("curve_grep_a", 1000);
    const long = await parkAt("curve_grep_b", 900_000);
    const line = (calls: unknown[][]): string => String(calls[0]?.[0]);
    expect(line(short.logger.info.mock.calls)).toContain("Workflow delivery parked");
    expect(line(long.logger.warn.mock.calls)).toContain("Workflow delivery parked");
  });
});
