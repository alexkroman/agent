// Copyright 2026 the AAI authors. MIT license.
/**
 * `withResumes` — which failures are an outage, and which are an answer.
 *
 * The loop itself is four lines; what is worth pinning is the classification,
 * because every entry in it is a decision about somebody's 600 MB recording.
 * Getting it wrong in one direction throws the file away on a redeploy, and in
 * the other re-sends it four times into an agent that has already said no.
 *
 * On virtual time, per the root guide: the waits between rounds are seconds by
 * design, and a spec that sits through them is a spec that flakes on a busy
 * runner while testing nothing about the delay.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isResumableFailure, withResumes } from "./_upload-resume.ts";
import { UPLOAD_RESUME_ATTEMPTS } from "./upload-constants.ts";
import { UploadNotRecordedError } from "./workflow-upload-parts.ts";

/** A failure carrying a status, the way `apiFailure` builds one. */
function answered(status: number): Error {
  return Object.assign(new Error(`the agent said ${status}`), { status });
}

/** A failure carrying none, the way a dropped connection arrives. */
function dropped(): Error {
  return new TypeError("fetch failed");
}

/** An abort, in the shape a signal produces. */
function aborted(): Error {
  return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

/** Drive the loop to settlement without waiting out its backoff. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  // Longer than the whole budget, so a spec never passes because it stopped
  // advancing early.
  const drive = vi.advanceTimersByTimeAsync(5 * 60_000);
  const value = await pending;
  await drive;
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isResumableFailure", () => {
  test("a failure with no status at all is the case this exists for", () => {
    // Nothing answered, so there is no far side saying no — a restarting agent,
    // a dropped connection, a DNS miss on a laptop that changed networks.
    expect(isResumableFailure(dropped())).toBe(true);
  });

  test("a COME BACK status comes back", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isResumableFailure(answered(status))).toBe(true);
    }
  });

  test("a refusal is an answer, and will be the same answer next time", () => {
    // 413 is the file being over the agent's cap and 400 is an offset that
    // contradicts the declared total: re-sending either spends the whole budget
    // to reach the sentence the person could have had immediately.
    for (const status of [400, 401, 403, 404, 409, 413]) {
      expect(isResumableFailure(answered(status))).toBe(false);
    }
  });

  test("an abort is the caller's decision, including a person's PAUSE", () => {
    expect(isResumableFailure(aborted())).toBe(false);
  });

  test("a record the agent never wrote is not repaired by sending it again", () => {
    expect(isResumableFailure(new UploadNotRecordedError("nothing was recorded"))).toBe(false);
  });
});

describe("withResumes", () => {
  test("re-enters with `resume` set, so the second round sends only what is missing", async () => {
    const rounds: (boolean | undefined)[] = [];
    const attempt = vi.fn(async (round: { resume: boolean | undefined }) => {
      rounds.push(round.resume);
      if (rounds.length < 3) throw dropped();
      return "stored";
    });

    await expect(settle(withResumes(attempt, { resume: undefined }))).resolves.toBe("stored");
    // The first round carries the CALLER's value and every later one is a resume
    // by definition — a fresh id has nothing to resume, and claiming otherwise
    // waives the refusal that makes a caller-chosen id safe.
    expect(rounds).toEqual([undefined, true, true]);
  });

  test("the caller's own `resume` decides the first round, because it chose the id", async () => {
    const attempt = vi.fn(async () => "stored");
    await expect(settle(withResumes(attempt, { resume: true }))).resolves.toBe("stored");
    expect(attempt).toHaveBeenCalledWith({ resume: true, round: 1 });
  });

  test("a refusal ends it at once rather than four times over", async () => {
    const attempt = vi.fn(async () => {
      throw answered(413);
    });
    await expect(settle(withResumes(attempt, { resume: undefined }))).rejects.toThrow("413");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("spends the whole budget on an outage, then throws the LAST failure", async () => {
    let round = 0;
    const attempt = vi.fn(async () => {
      round += 1;
      throw droppedAt(round);
    });
    await expect(settle(withResumes(attempt, { resume: undefined }))).rejects.toThrow(
      `round ${UPLOAD_RESUME_ATTEMPTS}`,
    );
    // The state the caller is actually in is the last one, not the one a minute ago.
    expect(attempt).toHaveBeenCalledTimes(UPLOAD_RESUME_ATTEMPTS);
  });

  test("an aborted signal ends the loop even when the failure looks resumable", async () => {
    // The pause case: the abort is what CAUSED the failure, so treating it as an
    // outage would have the uploader fighting the person who pressed the button.
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      controller.abort();
      throw dropped();
    });
    await expect(
      settle(withResumes(attempt, { resume: undefined, signal: controller.signal })),
    ).rejects.toThrow("fetch failed");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("a signal aborted during the WAIT throws rather than starting another round", async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      throw dropped();
    });
    const pending = withResumes(attempt, { resume: undefined, signal: controller.signal });
    const rejects = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await rejects;
    // One round, and the abort is what stopped the second: `sleep` resolves on an
    // abort rather than throwing, so a loop that did not re-check would carry on.
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("honours a caller's shorter budget", async () => {
    const attempt = vi.fn(async () => {
      throw dropped();
    });
    await expect(
      settle(withResumes(attempt, { resume: undefined, attempts: 2 })),
    ).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

/** A transport failure that names which round produced it. */
function droppedAt(round: number): Error {
  return new TypeError(`fetch failed on round ${round}`);
}
