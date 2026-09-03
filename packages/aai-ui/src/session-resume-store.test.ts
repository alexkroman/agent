// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// Where a session id survives a page reload, and the reload itself.
//
// The property: a reload presents the same `?sessionId=`, which is what makes the
// server's `syncState` push reach a UI that would otherwise come back empty.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lastSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createSessionCore } from "./session-core.ts";
import {
  clearStoredSessionId,
  readStoredSessionId,
  writeStoredSessionId,
} from "./session-resume-store.ts";

const AGENT = "ws://localhost:3000";
const OTHER = "ws://localhost:3000/other-agent/";

afterEach(() => {
  // Unstubbed FIRST: the spec below replaces the global with a hostile `Storage`,
  // and `restoreMocks`/`unstubEnvs` cover spies and env vars, not globals.
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("session-resume-store", () => {
  it("round-trips an id, and forgets it on demand", () => {
    expect(readStoredSessionId(AGENT)).toBeUndefined();
    writeStoredSessionId(AGENT, "sess-1");
    expect(readStoredSessionId(AGENT)).toBe("sess-1");
    clearStoredSessionId(AGENT);
    expect(readStoredSessionId(AGENT)).toBeUndefined();
  });

  it("keys by AGENT, so two agents on one origin never share a session", () => {
    // Every deployed agent is served from the same origin at `/:slug/`, so a
    // single key would have one agent resume into another's session — presenting
    // an id that names nothing, with the greeting suppressed.
    writeStoredSessionId(AGENT, "sess-a");
    writeStoredSessionId(OTHER, "sess-b");
    expect(readStoredSessionId(AGENT)).toBe("sess-a");
    expect(readStoredSessionId(OTHER)).toBe("sess-b");
  });

  it("treats a relative and an absolute URL for one agent as the same key", () => {
    // The default client is mounted with `platformUrl: "./"`; a custom client
    // may pass the absolute form of the very same agent.
    writeStoredSessionId("./", "sess-rel");
    expect(readStoredSessionId(new URL("./", window.location.href).href)).toBe("sess-rel");
  });

  it("degrades rather than throwing when storage is unavailable", () => {
    // Safari private mode and storage blocked by policy both THROW on access,
    // and a session that cannot be remembered must still start.
    const boom = () => {
      throw new Error("SecurityError");
    };
    // The GLOBAL is replaced, rather than a method spied, because
    // `globalThis.sessionStorage` is the expression the module evaluates and
    // `vi.stubGlobal` replaces it whether it is an accessor or a value. This
    // spec was stubbing NOTHING for as long as it existed: spying the instance is
    // taken by jsdom's named-property proxy as a write of an entry called
    // `getItem`, and it passed because nothing had been written yet, so the real
    // `getItem` also answered null. `Storage.prototype` is no better — it works
    // on Node 22 and is a no-op on Node 26, where the global `Storage` is not the
    // class behind jsdom's instance. `_upload-recall.test.ts` carries the rest.
    vi.stubGlobal("sessionStorage", {
      length: 0,
      clear: () => {
        // Nothing to clear; teardown unstubs this before clearing the real one.
      },
      getItem: boom,
      key: () => null,
      removeItem: boom,
      setItem: boom,
    });
    // Proof the stub bites. Without it this spec passes while intercepting
    // nothing, which is what it did.
    expect(() => globalThis.sessionStorage.setItem("k", "v")).toThrow(/SecurityError/);
    writeStoredSessionId(AGENT, "sess-unwritable");
    expect(readStoredSessionId(AGENT)).toBeUndefined();
    expect(() => writeStoredSessionId(AGENT, "sess-x")).not.toThrow();
    expect(() => clearStoredSessionId(AGENT)).not.toThrow();
  });
});

describe("a reload resumes", () => {
  /** A fresh core for the same agent — what a page reload constructs. */
  function reload() {
    resetLastSocket();
    return createSessionCore({ platformUrl: AGENT, WebSocket: MockWebSocketConstructor });
  }

  it("presents the id the previous load was given", () => {
    const first = reload();
    first.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig());

    // The reload. Nothing carries over in memory: this is a new core, exactly as
    // a new document would be.
    const second = reload();
    second.connect();
    expect(lastSocket?.url).toContain("sessionId=sess-123");
  });

  it("an explicit resumeSessionId still wins", () => {
    // A client that manages the id itself (`onSessionId` into its own storage)
    // must not be second-guessed.
    writeStoredSessionId(AGENT, "sess-stored");
    resetLastSocket();
    const core = createSessionCore({
      platformUrl: AGENT,
      WebSocket: MockWebSocketConstructor,
      resumeSessionId: "sess-explicit",
    });
    core.connect();
    expect(lastSocket?.url).toContain("sessionId=sess-explicit");
  });

  it("end() forgets it, so the next load is a NEW session", () => {
    // `end()` is the clear-and-forget behind "New Conversation". Leaving the id
    // stored would have the next load rejoin the conversation just discarded,
    // greeting suppressed — the one wrong answer that looks like a right one.
    const first = reload();
    first.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig());
    expect(readStoredSessionId(AGENT)).toBe("sess-123");

    first.end();
    expect(readStoredSessionId(AGENT)).toBeUndefined();

    const second = reload();
    second.connect();
    expect(lastSocket?.url).not.toContain("sessionId");
  });

  it("a config frame with no sessionId stores nothing", () => {
    // An older server omits it; there is no id to present, and storing an empty
    // string would make `readStoredSessionId` answer with a falsy id forever.
    const core = reload();
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig(16_000, 24_000, ""));
    expect(readStoredSessionId(AGENT)).toBeUndefined();
  });
});
