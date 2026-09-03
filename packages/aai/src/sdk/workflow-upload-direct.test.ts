// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the DIRECT path: a part whose bytes never reach the agent.
 *
 * On the managed platform they cannot usefully. A deployed guest holds no bucket
 * credential, so it reaches an upload's bytes through a route the platform serves —
 * and a part sent to the agent would cross that platform twice to land in the same
 * bucket, through a forward that measures a body's drain to decide whether the guest
 * is alive. So the claim advertises `directParts` and the client splits each window in
 * two: the bytes to the platform, then a bodyless request telling the agent which
 * window landed.
 *
 * What is asserted is the SPLIT and its two boundaries — that the agent's bearer does
 * not travel to a route that never checks it, and that a client only takes the path an
 * agent said exists. Driven against the same scripted `fetch` the ordinary fan-out
 * uses (`_upload-parts-test-utils.ts`).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { client, PART, recording, scriptAgent, TOTAL } from "./_upload-parts-test-utils.ts";
import { UPLOAD_CHUNK_BYTES } from "./constants.ts";
import { directBytesBase } from "./workflow-upload-parts.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  scriptAgent();
});

describe("a deployed agent's parts", () => {
  test("sends the BYTES to the platform and only the offset to the agent", async () => {
    const agent = scriptAgent({ direct: true });
    const stored = await client().upload(recording(), { name: "call.wav", parallel: true });

    // Every window's bytes went to the platform's own route, keyed by the byte it
    // starts at — which is also the object's name, so a retry is the same object. The
    // id is the client's own (a parts upload is always caller-named), so the shape is
    // what a spec can pin.
    // The upload id is the CLIENT's own — a parts upload is always caller-named — and
    // it is the same one in every window's key, which is what makes the three objects
    // one upload.
    const ids = new Set(agent.bytes.map((call) => call.url.pathname.split("/").at(-2)));
    expect(ids.size).toBe(1);
    const id = [...ids][0] ?? "";
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(agent.bytes.map((call) => call.url.pathname)).toEqual([
      `/my-agent/uploads/${id}/0`,
      `/my-agent/uploads/${id}/${PART}`,
      `/my-agent/uploads/${id}/${PART * 2}`,
    ]);
    expect(agent.bytes.map((call) => call.bytes)).toEqual([PART, PART, PART]);

    // And the agent was TOLD, with no body: this is the request that makes a window
    // count, and the store measures the object itself rather than trusting a size
    // here — which is what stops a client advancing `size` past a hole.
    const told = agent.parts.filter((call) => call.method === "PUT");
    expect(told.map((call) => call.url.searchParams.get("stored"))).toEqual(["1", "1", "1"]);
    expect(told.map((call) => call.bytes)).toEqual([0, 0, 0]);
    expect(stored).toMatchObject({ size: TOTAL, complete: true });
  });

  test("does not send the agent's bearer to the platform's route", async () => {
    // A different surface with a different auth model: `AAI_WORKFLOW_API_TOKEN` means
    // nothing there, and a header that travels is a bearer handed to something that
    // will not check it.
    const agent = scriptAgent({ direct: true });
    await client({ token: "sekret" }).upload(recording(PART * 2), { parallel: true });
    expect(agent.bytes).not.toHaveLength(0);
    for (const call of agent.bytes) expect(call.headers.authorization).toBeUndefined();
    // The agent's own requests still carry it, which is the other half of the claim.
    const told = agent.parts.filter((call) => call.method === "PUT");
    for (const call of told) expect(call.headers.authorization).toBe("Bearer sekret");
  });

  test("keeps sending bodies to an agent that did NOT advertise the route", async () => {
    // `aai dev` and a self-hosted server hold the bucket credential themselves and
    // serve no such route — and so does an agent deployed before any of this existed.
    // Absent is the same answer in all three cases, which is why the flag is omitted
    // rather than sent as `false`.
    const agent = scriptAgent();
    await client().upload(recording(), { parallel: true });
    expect(agent.bytes).toEqual([]);
    const told = agent.parts.filter((call) => call.method === "PUT");
    expect(told.map((call) => call.bytes)).toEqual([PART, PART, PART]);
    expect(told.map((call) => call.url.searchParams.get("stored"))).toEqual([null, null, null]);
  });

  test("re-sends the whole WINDOW when the record is lost, not just the record", async () => {
    // The two halves are retried as one unit deliberately: a stored object nobody
    // recorded is an orphan no reader can see, so re-sending the bytes and recording
    // them again is the only repair that leaves the bucket and the record agreeing.
    const agent = scriptAgent({ direct: true, refuse: { offset: 0, status: 503 } });
    await client().upload(recording(PART * 2), { parallel: true });
    // Two byte writes at offset 0 — the first attempt and the retry — against one at
    // the other offset.
    const at = (offset: number) =>
      agent.bytes.filter((call) => call.url.pathname.endsWith(`/${offset}`)).length;
    expect(at(0)).toBe(2);
    expect(at(PART)).toBe(1);
  });
});

describe("a batched claim", () => {
  test("names several landed windows in ONE request when the agent said it may", async () => {
    // The whole point of the batch. A claim carries no bytes and cost ~1.7s against a
    // deployed agent, per part — about half of an upload's wall clock — so what is
    // asserted here is that three windows are claimed in fewer than three requests,
    // and that between them they name every one.
    const agent = scriptAgent({ direct: true, claimBatch: 32 });
    const stored = await client().upload(recording(), { name: "call.wav", parallel: true });

    const told = agent.parts.filter((call) => call.method === "PUT");
    expect(told.length).toBeLessThan(3);
    const claimed = told.flatMap((call) => call.url.searchParams.getAll("offset").map(Number));
    expect([...claimed].sort((a, b) => a - b)).toEqual([0, PART, PART * 2]);
    // Still body-less, and still the request that makes a window count.
    expect(told.map((call) => call.bytes)).toEqual(told.map(() => 0));
    for (const call of told) expect(call.url.searchParams.get("stored")).toBe("1");
    // And every window's BYTES still went to the platform, one request each: batching
    // is about the receipt, never about the bodies.
    expect(agent.bytes).toHaveLength(3);
    expect(stored).toMatchObject({ size: TOTAL, complete: true });
  });

  test("claims ONE offset per request against an agent that did not advertise a batch", async () => {
    // The skew that has no symptom. `directParts` and `claimBatch` shipped in
    // different versions, so an agent may serve the direct path and still read a
    // single `?offset=` — which would record the first window of a batch, answer 200,
    // and leave the rest as holes that read as silence in a step, minutes later.
    const agent = scriptAgent({ direct: true });
    await client().upload(recording(), { parallel: true });

    const told = agent.parts.filter((call) => call.method === "PUT");
    expect(told).toHaveLength(3);
    for (const call of told) {
      expect(call.url.searchParams.getAll("offset")).toHaveLength(1);
    }
  });

  test("refuses a batch the agent advertised as one, which is not a batch", async () => {
    // `claimBatch: 1` and an absent field are the same instruction, and a client that
    // read `1` as "batch of one" would compose the same request either way — so this
    // pins that the floor is a NUMBER ABOVE ONE rather than mere presence.
    const agent = scriptAgent({ direct: true, claimBatch: 1 });
    await client().upload(recording(), { parallel: true });
    const told = agent.parts.filter((call) => call.method === "PUT");
    expect(told).toHaveLength(3);
  });

  test("honours the agent's CAP rather than sending every pending offset", async () => {
    // The cap is the agent's number, and a client that ignored it would compose a
    // request the route answers 400 — a refusal, so not retried, so the whole upload.
    const agent = scriptAgent({ direct: true, claimBatch: 2 });
    await client().upload(recording(), { parallel: true });
    const told = agent.parts.filter((call) => call.method === "PUT");
    for (const call of told) {
      expect(call.url.searchParams.getAll("offset").length).toBeLessThanOrEqual(2);
    }
    const claimed = told.flatMap((call) => call.url.searchParams.getAll("offset").map(Number));
    expect([...claimed].sort((a, b) => a - b)).toEqual([0, PART, PART * 2]);
  });

  test("collapses the MANY claims a resumable upload's chunk-sized windows create", async () => {
    // The two changes meet here. A caller-named upload is cut at `UPLOAD_CHUNK_BYTES`
    // rather than at the part size, so it can resume from where it stopped — which
    // turns an ordinary phone recording into eight windows where the speed path would
    // have sent one. Each of those used to owe its own body-less claim, so the fix
    // that made small uploads resumable also multiplied the receipt toll by eight.
    const agent = scriptAgent({ direct: true, claimBatch: 32 });
    const windows = 8;
    await client().uploadStream("abc", recording(UPLOAD_CHUNK_BYTES * windows), {
      parallel: true,
    });

    const told = agent.parts.filter((call) => call.method === "PUT");
    expect(agent.bytes).toHaveLength(windows);
    expect(told.length).toBeLessThan(windows);
    const claimed = told.flatMap((call) => call.url.searchParams.getAll("offset").map(Number));
    expect([...claimed].sort((a, b) => a - b)).toEqual(
      Array.from({ length: windows }, (_unused, at) => at * UPLOAD_CHUNK_BYTES),
    );
  });

  test("a RESUME stays on the direct path, reading the flag off the record", async () => {
    // A resume re-declares an id it already owns, so the store answers 409 — and a
    // 409 carries no body to read `directParts` from. This used to fall back to
    // sending every remaining window's BYTES to the agent: it works, and it is the
    // topology the direct path exists to avoid, and the platform's forward measures
    // that drain to decide whether a guest is alive.
    const agent = scriptAgent({
      direct: true,
      claimBatch: 32,
      begin: 409,
      landed: [{ start: 0, end: PART }],
    });
    const stored = await client().uploadStream("abc", recording(), {
      parallel: true,
      resume: true,
    });

    // The two windows still owed went to the PLATFORM, not to the agent.
    expect(agent.bytes.map((call) => call.url.pathname.split("/").at(-1))).toEqual([
      String(PART),
      String(PART * 2),
    ]);
    // And the agent heard about them the body-less way, batched.
    const told = agent.parts.filter((call) => call.method === "PUT");
    expect(told.map((call) => call.bytes)).toEqual(told.map(() => 0));
    const claimed = told.flatMap((call) => call.url.searchParams.getAll("offset").map(Number));
    expect([...claimed].sort((a, b) => a - b)).toEqual([PART, PART * 2]);
    expect(stored).toMatchObject({ size: TOTAL, complete: true });
  });

  test("a resume against an agent whose RECORD says nothing sends bodies, as before", async () => {
    // The degradation, and it has to stay: an agent too old to answer the capability
    // on `…/info` is the same answer as one where the bytes come to it, and guessing
    // otherwise sends a window into a 404.
    const agent = scriptAgent({ begin: 409, landed: [{ start: 0, end: PART }] });
    await client().uploadStream("abc", recording(), { parallel: true, resume: true });
    expect(agent.bytes).toHaveLength(0);
    const told = agent.parts.filter((call) => call.method === "PUT");
    expect(told.map((call) => call.bytes)).toEqual([PART, PART]);
  });

  test("fails the upload when a batched claim is refused", async () => {
    // Every window a failed claim named is a stored object the agent has no record
    // of, so this must not resolve: the closing read would otherwise report an upload
    // the agent acknowledged and did not write. The refusal is `always`, since one is
    // absorbed by the retry inside the round.
    const agent = scriptAgent({
      direct: true,
      claimBatch: 32,
      refuse: { offset: 0, always: true },
    });
    await expect(client().upload(recording(), { parallel: true })).rejects.toThrow();
    expect(agent.bytes).not.toHaveLength(0);
  });
});

describe("where the platform serves the bytes", () => {
  test("is one segment ACROSS from the API, not one level up", () => {
    // Both routes hang off the same agent prefix, and the base is the only thing in
    // this client that knows what that prefix is — it may be an origin, a path under
    // one, or a `/:slug` on the platform.
    expect(directBytesBase("https://agents.example/my-agent/workflows")).toBe(
      "https://agents.example/my-agent/uploads",
    );
    expect(directBytesBase("https://agents.example/workflows/")).toBe(
      "https://agents.example/uploads",
    );
  });

  test("DECLINES a base it does not recognise", () => {
    // Rather than guessing: sending 8 MiB to a URL derived from a shape nobody
    // recognises is exactly the 404 the capability flag exists to prevent.
    expect(directBytesBase("https://agents.example/my-agent")).toBeUndefined();
    expect(directBytesBase("")).toBeUndefined();
  });
});
