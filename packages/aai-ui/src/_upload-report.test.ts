// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { coalesceUploadReports } from "./_upload-report.ts";
import type { UploadStatus } from "./use-workflow-form.ts";

function status(over: Partial<UploadStatus> = {}): UploadStatus {
  return {
    name: "recording.wav",
    index: 1,
    count: 1,
    loaded: 0,
    total: 1000,
    fraction: 0,
    paused: false,
    ...over,
  };
}

describe("coalesceUploadReports", () => {
  test("drops a report that would render identically", () => {
    const set = vi.fn();
    const report = coalesceUploadReports(set);

    // Two byte counts inside the same tenth of a percent of a 1000-byte file.
    report(status({ loaded: 100, fraction: 0.1 }));
    report(status({ loaded: 100, fraction: 0.1 }));

    expect(set).toHaveBeenCalledTimes(1);
  });

  test("passes a report whose rendered fraction moved", () => {
    const set = vi.fn();
    const report = coalesceUploadReports(set);

    report(status({ loaded: 100, fraction: 0.1 }));
    report(status({ loaded: 500, fraction: 0.5 }));

    expect(set).toHaveBeenCalledTimes(2);
  });

  test("never coalesces a pause transition", () => {
    const set = vi.fn();
    const report = coalesceUploadReports(set);

    // Identical but for `paused`, which is the state a person is waiting to see.
    report(status({ loaded: 100, fraction: 0.1 }));
    report(status({ loaded: 100, fraction: 0.1, paused: true }));

    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ paused: true }));
  });

  test("never coalesces across a change of FILE", () => {
    const set = vi.fn();
    const report = coalesceUploadReports(set);

    // Same progress numbers, different file in the submission.
    report(status({ name: "a.wav", index: 1, count: 2, loaded: 100, fraction: 0.1 }));
    report(status({ name: "b.wav", index: 2, count: 2, loaded: 100, fraction: 0.1 }));

    expect(set).toHaveBeenCalledTimes(2);
  });

  test("clearing always passes and resets the comparison", () => {
    const set = vi.fn();
    const report = coalesceUploadReports(set);

    const first = status({ loaded: 100, fraction: 0.1 });
    report(first);
    report(undefined);
    // The next file must not be coalesced against the previous one's last frame.
    report(first);

    expect(set.mock.calls.map(([arg]) => arg)).toEqual([first, undefined, first]);
  });

  test("an unknown total falls back to comparing raw bytes", () => {
    const set = vi.fn();
    const report = coalesceUploadReports(set);

    report(status({ total: undefined, fraction: undefined, loaded: 10 }));
    report(status({ total: undefined, fraction: undefined, loaded: 10 }));
    report(status({ total: undefined, fraction: undefined, loaded: 11 }));

    expect(set).toHaveBeenCalledTimes(2);
  });
});
