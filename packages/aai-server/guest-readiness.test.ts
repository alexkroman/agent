// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the guest readiness waits (guest-readiness.ts): the exit race
 * every boot wait runs under, so a guest that explained its own failure on
 * stderr is not misreported as a network timeout.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, it } from "vitest";
import { raceGuestExit } from "./guest-readiness.ts";

/**
 * Every way a guest fails to come up exits the process, with the reason on
 * its stderr. Without this race a readiness wait burns its whole budget and
 * then blames the network for what the guest already explained.
 */
describe("raceGuestExit", () => {
  const stream = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        c.close();
      },
    });

  const procThat = (wait: () => Promise<number>) => ({
    stdout: stream(),
    stderr: stream(),
    wait,
  });

  it("resolves with the work when the guest stays up", async () => {
    const proc = procThat(() => new Promise<number>(() => undefined));
    await expect(raceGuestExit(Promise.resolve("ready"), proc)).resolves.toBe("ready");
  });

  it("fails with the exit code when the guest dies first", async () => {
    const proc = procThat(() => Promise.resolve(3));
    await expect(raceGuestExit(new Promise<void>(() => undefined), proc)).rejects.toThrow(
      /guest exited before ready \(exit 3\)/,
    );
  });

  it("reports a rejected wait as an exit rather than hanging", async () => {
    const proc = procThat(() => Promise.reject(new Error("gone")));
    await expect(raceGuestExit(new Promise<void>(() => undefined), proc)).rejects.toThrow(
      /guest exited before ready \(exit -1\)/,
    );
  });

  it("propagates the work's own failure untouched", async () => {
    const proc = procThat(() => new Promise<number>(() => undefined));
    await expect(raceGuestExit(Promise.reject(new Error("probe timeout")), proc)).rejects.toThrow(
      "probe timeout",
    );
  });

  // The losing branch settles after the race is decided; an unhandled
  // rejection there would take down the process under Node's default.
  it("contains a work rejection that lands after the exit", async () => {
    let failWork: (err: Error) => void = () => undefined;
    const work = new Promise<void>((_resolve, reject) => {
      failWork = reject;
    });
    const proc = procThat(() => Promise.resolve(1));
    await expect(raceGuestExit(work, proc)).rejects.toThrow(/exit 1/);
    failWork(new Error("late"));
    await sleep(0);
  });
});
