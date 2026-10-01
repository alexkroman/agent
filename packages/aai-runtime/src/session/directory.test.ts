// Copyright 2026 the AAI authors. MIT license.
// The live-session directory's one rule, from each reader's side: a reach for
// an id answers whatever holds it NOW, and an old holder's late release never
// evicts its successor.

import { describe, expect, test, vi } from "vitest";
import type { ServerSession } from "./core-types.ts";
import { createSessionDirectory, type SessionWiring } from "./directory.ts";

/** A session double: only the members the directory's readers touch. */
function session(announce = vi.fn(() => true)): ServerSession {
  return {
    announce,
    say: vi.fn(() => ({ done: Promise.resolve("played" as const), interrupt: () => undefined })),
    interrupt: vi.fn(() => true),
  } as Partial<ServerSession> as ServerSession;
}

function wiring(): SessionWiring {
  return {
    sink: {} as SessionWiring["sink"],
    emitter: {} as SessionWiring["emitter"],
    meter: {} as SessionWiring["meter"],
  };
}

describe("createSessionDirectory", () => {
  test("a resume's claim takes the id, and the old claim's release leaves it alone", () => {
    const directory = createSessionDirectory();
    const first = session();
    const resumed = session();
    const releaseFirst = directory.claim("s-1", first);
    directory.claim("s-1", resumed);

    expect(releaseFirst()).toBe(false);
    expect(directory.session("s-1")).toBe(resumed);
    expect([...directory.live()]).toEqual([resumed]);
    expect([...directory.ids()]).toEqual(["s-1"]);
    expect(directory.size).toBe(1);
  });

  test("speech follows the id across a resume", () => {
    const directory = createSessionDirectory();
    const speech = directory.speech.of("s-1");
    const first = vi.fn(() => true);
    const resumed = vi.fn(() => true);
    directory.claim("s-1", session(first));
    directory.claim("s-1", session(resumed));

    expect(directory.speech.announce("s-1", "done")).toBe(true);
    expect(resumed).toHaveBeenCalledWith("done");
    expect(first).not.toHaveBeenCalled();
    expect(directory.speech.live("s-2")).toBeUndefined();
    expect(speech.interrupt()).toBe(true);
  });

  test("a session's wiring is claimed and released as one, by claim", () => {
    const directory = createSessionDirectory();
    const old = wiring();
    const next = wiring();
    const releaseOld = directory.claimWiring("s-1", old);
    const releaseNext = directory.claimWiring("s-1", next);

    expect(releaseOld()).toBe(false);
    expect(directory.emitter("s-1")).toBe(next.emitter);
    expect(directory.meter("s-1")).toBe(next.meter);
    expect(releaseNext()).toBe(true);
    expect(directory.emitter("s-1")).toBeUndefined();
    expect(directory.meter("s-1")).toBeUndefined();
  });

  test("clear drops every registry", () => {
    const directory = createSessionDirectory();
    directory.claim("s-1", session());
    directory.claimWiring("s-1", wiring());
    directory.clear();
    expect(directory.session("s-1")).toBeUndefined();
    expect(directory.emitter("s-1")).toBeUndefined();
    expect(directory.size).toBe(0);
  });
});
