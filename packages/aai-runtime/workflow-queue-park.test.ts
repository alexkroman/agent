// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the park cadence: the curve, and the line that reports it.
 *
 * The curve is a pure function of one number, so it is unit-testable to the
 * point of exhaustion — which matters, because the shape it replaced was a
 * CONSTANT and every existing door spec agreed with it at
 * `walkingForSeconds: 0`. That is how the flat version shipped: the assertions
 * were all taken at the one elapsed time where a constant and a curve cannot be
 * told apart.
 */

import { describe, expect, test, vi } from "vitest";
import {
  QUEUE_DELIVERY_BUSY_DIVISOR,
  QUEUE_DELIVERY_BUSY_MAX_SECONDS,
  QUEUE_DELIVERY_BUSY_SECONDS,
  QUEUE_DELIVERY_LONG_WALK_SECONDS,
  queueDeliveryBusySeconds,
  reportPark,
} from "./workflow-queue-park.ts";

/**
 * The park delay is a CURVE, and pinning both ends is the whole test.
 *
 * A suite that checked only the backoff would pass against a version that lost
 * the fast first retry, which is the case the flat delay was written for: two
 * deliveries briefly racing, where the loser should come back promptly. And a
 * suite that checked only the floor is what let the flat version ship — every
 * assertion in this file passed at `walkingForSeconds: 0`, where the curve and
 * the constant agree.
 */
describe("queueDeliveryBusySeconds", () => {
  test("holds the FLOOR for a brief overlap, which is what the flat delay was for", () => {
    // The floor binds below `5 * DIVISOR` seconds of walk — 40s — and a race
    // between two deliveries of one run happens seconds in, not minutes.
    expect(queueDeliveryBusySeconds(0)).toBe(QUEUE_DELIVERY_BUSY_SECONDS);
    expect(queueDeliveryBusySeconds(1)).toBe(QUEUE_DELIVERY_BUSY_SECONDS);
    expect(
      queueDeliveryBusySeconds(QUEUE_DELIVERY_BUSY_SECONDS * QUEUE_DELIVERY_BUSY_DIVISOR),
    ).toBe(QUEUE_DELIVERY_BUSY_SECONDS);
  });

  test("the long-walk THRESHOLD sits between the two measured healthy runs", () => {
    // 3m21s (201s) nobody minded; 15m00s (900s) its author cancelled. A
    // threshold outside that pair is either a warn on every slow step or a warn
    // on none — see `QUEUE_DELIVERY_LONG_WALK_SECONDS`.
    expect(QUEUE_DELIVERY_LONG_WALK_SECONDS).toBeGreaterThan(201);
    expect(QUEUE_DELIVERY_LONG_WALK_SECONDS).toBeLessThan(900);
  });

  test("BACKS OFF proportionately once a walk is long", () => {
    // One eighth of the elapsed walk. The production line that prompted this
    // read `walkingForSeconds: 285, retryInSeconds: 5`.
    expect(queueDeliveryBusySeconds(285)).toBe(36);
    expect(queueDeliveryBusySeconds(900)).toBe(113);
  });

  test("the first park of any run is still nearly as fast as the flat delay", () => {
    // ~61s, because a delivery is only re-presented after
    // `QUEUE_DELIVERY_TIMEOUT_MS` closes the previous response. So the curve
    // costs the first park 3 seconds, which is the whole of what backing off
    // gives up on the short end.
    expect(queueDeliveryBusySeconds(61)).toBe(8);
  });

  test("CAPS, so a walk that really died is re-walked promptly", () => {
    // Well under `RETRY_BACKOFF_MS`'s longest entry (300s), `STALL_GRACE_MS`
    // (600s) and `TRANSCRIBE_UPLOAD_TIMEOUT_MS` (1800s) — see the constant.
    expect(queueDeliveryBusySeconds(3600)).toBe(QUEUE_DELIVERY_BUSY_MAX_SECONDS);
    expect(queueDeliveryBusySeconds(Number.MAX_SAFE_INTEGER)).toBe(QUEUE_DELIVERY_BUSY_MAX_SECONDS);
    expect(QUEUE_DELIVERY_BUSY_MAX_SECONDS).toBeLessThan(300);
  });

  test("MONOTONIC, so a longer walk is never asked back sooner", () => {
    let previous = 0;
    for (let elapsed = 0; elapsed <= 2000; elapsed += 7) {
      const seconds = queueDeliveryBusySeconds(elapsed);
      expect(seconds).toBeGreaterThanOrEqual(previous);
      previous = seconds;
    }
  });

  test("answers the FLOOR for a clock that stepped backwards or went bad", () => {
    // `NaN` is the one that matters: JSON has no NaN, so it would reach the
    // platform as `null`, `parkedFor` reads a body with no finite
    // `timeoutSeconds` as COMPLETED, and the run is silently stranded.
    expect(queueDeliveryBusySeconds(-30)).toBe(QUEUE_DELIVERY_BUSY_SECONDS);
    expect(queueDeliveryBusySeconds(Number.NaN)).toBe(QUEUE_DELIVERY_BUSY_SECONDS);
    expect(queueDeliveryBusySeconds(Number.POSITIVE_INFINITY)).toBe(QUEUE_DELIVERY_BUSY_SECONDS);
  });
});

describe("reportPark", () => {
  const fakeLogger = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });

  test("ANSWERS the delay it reported, so the line and the wire body agree", () => {
    // The property the split has to preserve: one park is one line AND one
    // reschedule, and the caller puts this return value straight into the
    // response body. Two computations of one curve is how they would drift.
    const logger = fakeLogger();
    const base = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(base + 285_000);
    const retry = reportPark(logger, "r1", base);
    expect(retry).toBe(queueDeliveryBusySeconds(285));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("parked"), {
      runId: "r1",
      walkingForSeconds: 285,
      retryInSeconds: retry,
    });
  });

  test("a logger is optional, and its absence changes the answer not at all", () => {
    // `handleWorkflowRequest` defaults it to `consoleLogger`; the only callers
    // with none are specs. The delay must not depend on who is listening.
    const base = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(base + 900_000);
    expect(reportPark(undefined, "r2", base)).toBe(queueDeliveryBusySeconds(900));
  });

  test("never reports at ERROR, because nothing has failed", () => {
    const logger = fakeLogger();
    reportPark(logger, "r3", Date.now() - 3_600_000);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
