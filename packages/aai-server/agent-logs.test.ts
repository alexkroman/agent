// Copyright 2026 the AAI authors. MIT license.
import type { LogPage } from "@alexkroman1/aai-runtime";
import { describe, expect, test, vi } from "vitest";
import { emptyLogPage, parseLogPage, readAgentLogs, readGuestLogs } from "./agent-logs.ts";
import { GUEST_TOKEN_SECRET_ENV, guestTokenFor } from "./guest-token.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { createSlotCache, setSlot } from "./sandbox-slots.ts";
import { createTestStore, fakeSandbox } from "./test-utils.ts";

const ORIGIN = "wss://tunnel.test:443";
const LINE = { seq: 0, at: 1, stream: "stdout" as const, text: "hello" };

/** A `fetch` double whose recorded calls keep their argument types. */
function jsonFetch(body: unknown, status = 200) {
  return vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
}

describe("readGuestLogs", () => {
  test("reads the guest's ring with the manage bearer and the caller's cursor", async () => {
    const fetchFn = jsonFetch({ lines: [LINE], cursor: 0, dropped: 0 });

    const page = await readGuestLogs({ guestOrigin: ORIGIN, token: "t", after: 7, fetchFn });

    expect(page.lines).toEqual([LINE]);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://tunnel.test/manage/logs?after=7");
    expect(init?.headers).toMatchObject({ authorization: "Bearer t" });
  });

  test("forwards a limit only when the caller set one", async () => {
    const fetchFn = jsonFetch({ lines: [], cursor: -1, dropped: 0 });
    await readGuestLogs({ guestOrigin: ORIGIN, token: "t", fetchFn });
    expect(String(fetchFn.mock.calls[0]?.[0])).not.toContain("limit");

    await readGuestLogs({ guestOrigin: ORIGIN, token: "t", limit: 5, fetchFn });
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain("limit=5");
  });

  test("an unreachable guest is an empty page at the caller's cursor, never a throw", async () => {
    const fetchFn = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(
      readGuestLogs({ guestOrigin: ORIGIN, token: "t", after: 12, fetchFn }),
    ).resolves.toEqual(emptyLogPage(12));
  });

  test("a 404 from a guest too old for the route degrades rather than failing", async () => {
    // Deployed agents spawn from the harness image pinned on their row, so a
    // guest can predate this route entirely.
    const fetchFn = jsonFetch({ error: "not found" }, 404);
    await expect(readGuestLogs({ guestOrigin: ORIGIN, token: "t", fetchFn })).resolves.toEqual(
      emptyLogPage(-1),
    );
  });
});

describe("parseLogPage", () => {
  test("keeps the well-formed lines and drops the rest individually", () => {
    const page = parseLogPage(
      { lines: [LINE, { seq: "1", at: 2, stream: "stdout", text: "x" }, null], cursor: 0 },
      -1,
    );
    expect(page.lines).toEqual([LINE]);
  });

  test("rejects a stream name that is neither of the two", () => {
    expect(parseLogPage({ lines: [{ ...LINE, stream: "syslog" }], cursor: 0 }, -1).lines).toEqual(
      [],
    );
  });

  test("never lets the guest rewind the cursor, which would replay forever", () => {
    expect(parseLogPage({ lines: [], cursor: 3 }, 10).cursor).toBe(10);
    expect(parseLogPage({ lines: [], cursor: 12 }, 10).cursor).toBe(12);
  });

  test("a body that is not a page at all degrades to empty", () => {
    for (const body of [null, "nope", 7, {}, { lines: "no" }]) {
      expect(parseLogPage(body, 4)).toEqual(emptyLogPage(4));
    }
  });

  test("a negative or absent dropped count reads as no gap", () => {
    expect(parseLogPage({ lines: [], cursor: 0, dropped: -3 }, -1).dropped).toBe(0);
    expect(parseLogPage({ lines: [], cursor: 0 }, -1).dropped).toBe(0);
  });
});

describe("readAgentLogs", () => {
  const page: LogPage = { lines: [LINE], cursor: 0, dropped: 0 };

  test("reads this replica's resident and reports it running", async () => {
    const slots = createSlotCache();
    const logs = vi.fn(() => Promise.resolve(page));
    setSlot(slots, { slug: "mine", sandbox: fakeSandbox({ logs }) });

    await expect(
      readAgentLogs({ slots, store: createTestStore() }, "mine", { after: 3 }),
    ).resolves.toEqual({ ...page, running: true });
    expect(logs).toHaveBeenCalledWith({ after: 3 });
  });

  test("a slug with no guest anywhere is `running: false`, not an error", async () => {
    await expect(
      readAgentLogs({ slots: createSlotCache(), store: createTestStore() }, "gone", { after: 2 }),
    ).resolves.toEqual({ ...emptyLogPage(2), running: false });
  });

  test("a dead resident is not treated as running", async () => {
    const slots = createSlotCache();
    setSlot(slots, {
      slug: "dead",
      sandbox: fakeSandbox({ alive: () => false, logs: () => Promise.resolve(page) }),
    });

    await expect(
      readAgentLogs({ slots, store: createTestStore() }, "dead", {}),
    ).resolves.toMatchObject({ running: false });
  });

  test("falls through to a PEER's guest, authenticating with the DERIVED token", async () => {
    // The whole point of deriving it: this replica never spawned the sandbox
    // and can still open its manage surface. Asserting the header is what makes
    // that a test rather than a claim — a random token would 401 here.
    vi.stubEnv(GUEST_TOKEN_SECRET_ENV, "shared");
    const store = createTestStore();
    vi.spyOn(store, "getAgentVersion").mockResolvedValue(4);
    const fetchFn = jsonFetch({ lines: [LINE], cursor: 0, dropped: 0 });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchFn);
    const directory = {
      find: () => Promise.resolve({ sessionUrl: `${ORIGIN}/websocket`, guestOrigin: ORIGIN }),
    };

    const result = await readAgentLogs(
      { slots: createSlotCache(), store, directory },
      "elsewhere",
      {},
    );

    expect(result).toEqual({ lines: [LINE], cursor: 0, dropped: 0, running: true });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toContain("/manage/logs");
    expect(init?.headers).toEqual({
      authorization: `Bearer ${guestTokenFor(agentSandboxName("elsewhere", 4))}`,
    });
  });

  test("a deleted agent's draining sandbox is not this slug's log", async () => {
    const store = createTestStore();
    vi.spyOn(store, "getAgentVersion").mockResolvedValue(null);
    const find = vi.fn();

    await expect(
      readAgentLogs({ slots: createSlotCache(), store, directory: { find } }, "deleted", {}),
    ).resolves.toMatchObject({ running: false });
    expect(find).not.toHaveBeenCalled();
  });

  test("a directory blip reads as no peer rather than failing the read", async () => {
    const store = createTestStore();
    vi.spyOn(store, "getAgentVersion").mockRejectedValue(new Error("db down"));

    await expect(
      readAgentLogs(
        { slots: createSlotCache(), store, directory: { find: () => Promise.resolve(null) } },
        "blip",
        {},
      ),
    ).resolves.toMatchObject({ running: false });
  });
});
