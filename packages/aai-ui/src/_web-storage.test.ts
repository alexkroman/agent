// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the guarded key-value store access three modules share.
 *
 * The stores are FAKES stubbed onto `globalThis`, not jsdom's: what is under
 * test is the guard around the global lookup itself — a store that is absent,
 * and one whose every call throws (Safari private mode, a policy-blocked
 * iframe) — and neither is a state jsdom's real store can be put in.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { storageGet, storageRemove, storageSet, urlSlot } from "./_web-storage.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A working in-memory `Storage`. */
function memoryStore(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

/** A `Storage` whose every call throws, the way a blocked one does. */
function refusingStore(): Storage {
  const refuse = (): never => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return {
    length: 0,
    clear: refuse,
    getItem: refuse,
    key: refuse,
    removeItem: refuse,
    setItem: refuse,
  };
}

describe("storageGet / storageSet / storageRemove", () => {
  test("round-trips through the store each kind names", () => {
    const session = memoryStore();
    const local = memoryStore();
    vi.stubGlobal("sessionStorage", session);
    vi.stubGlobal("localStorage", local);

    storageSet("session", "k", "in-session");
    storageSet("local", "k", "in-local");
    expect(storageGet("session", "k")).toBe("in-session");
    expect(storageGet("local", "k")).toBe("in-local");
    // Two stores, not one: a session entry never answers a local read.
    expect(session.getItem("k")).toBe("in-session");
    expect(local.getItem("k")).toBe("in-local");

    storageRemove("session", "k");
    expect(storageGet("session", "k")).toBeUndefined();
    expect(storageGet("local", "k")).toBe("in-local");
  });

  test("a missing entry reads as undefined, not null", () => {
    vi.stubGlobal("sessionStorage", memoryStore());
    expect(storageGet("session", "never-written")).toBeUndefined();
  });

  test("an ABSENT store degrades to the no-memory behaviour", () => {
    vi.stubGlobal("sessionStorage", undefined);
    expect(() => storageSet("session", "k", "v")).not.toThrow();
    expect(storageGet("session", "k")).toBeUndefined();
    expect(() => storageRemove("session", "k")).not.toThrow();
  });

  test("a store that THROWS is a no-op, never a throw", () => {
    vi.stubGlobal("localStorage", refusingStore());
    expect(() => storageSet("local", "k", "v")).not.toThrow();
    expect(storageGet("local", "k")).toBeUndefined();
    expect(() => storageRemove("local", "k")).not.toThrow();
  });

  test("a store whose very LOOKUP throws is guarded too", () => {
    // Reaching for the property is what throws in some contexts, before any
    // method is called — the reason the guard wraps the lookup.
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      expect(storageGet("session", "k")).toBeUndefined();
      expect(() => storageSet("session", "k", "v")).not.toThrow();
      expect(() => storageRemove("session", "k")).not.toThrow();
    } finally {
      // A getter defined by hand is not one `vi.unstubAllGlobals` knows to undo.
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });
});

describe("urlSlot", () => {
  test("resolves a relative target against the document, so both spellings agree", () => {
    vi.stubGlobal("location", { href: "https://host.test/agent/index.html" });
    expect(urlSlot("aai:x:", "./")).toBe("aai:x:https://host.test/agent/");
    expect(urlSlot("aai:x:", "https://host.test/agent/")).toBe("aai:x:https://host.test/agent/");
  });

  test("two agents on one origin get two slots", () => {
    vi.stubGlobal("location", { href: "https://host.test/" });
    expect(urlSlot("aai:x:", "/one/")).not.toBe(urlSlot("aai:x:", "/two/"));
  });

  test("an unresolvable target keeps the raw string, which still separates agents", () => {
    // No document at all: a relative URL has nothing to resolve against.
    vi.stubGlobal("location", undefined);
    expect(urlSlot("aai:x:", "./")).toBe("aai:x:./");
  });
});
