// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the `/parts` pair: ONE upload over SEVERAL connections.
 *
 * `POST …/parts` declares an upload and its total, and `PUT …/parts?offset=` fills in
 * a window of it — either carrying the bytes, or naming windows the client already
 * put in the platform's bucket (`&stored=1`, the direct path). Split from
 * `workflow-api-uploads.test.ts` when the two route groups together went past the
 * test-file line cap; the harness is shared, so the halves cannot drift on what a
 * store does.
 *
 * The store-level counterpart is `workflow-uploads-parts.test.ts`, which drives the
 * real store rather than the routes over a fake one.
 */

import { UPLOAD_CHUNK_BYTES, UPLOAD_CLAIM_BATCH } from "@alexkroman1/aai/host-internal";
import { afterEach, describe, expect, test } from "vitest";
import { closeServer, current, serve } from "./_workflow-api-uploads-test-utils.ts";

afterEach(closeServer);

describe("the parts routes", () => {
  /** Declare an upload its parts will fill in, and answer what the route said. */
  async function begin(
    base: string,
    id: string,
    total: number,
    init: { name?: string; type?: string } = {},
  ): Promise<Response> {
    return await fetch(
      `${base}/workflows/uploads/${id}/parts?name=${encodeURIComponent(init.name ?? "")}&total=${total}`,
      { method: "POST", headers: { "Content-Type": init.type ?? "application/octet-stream" } },
    );
  }

  /** Send one window of it. */
  async function part(
    base: string,
    id: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<Response> {
    return await fetch(`${base}/workflows/uploads/${id}/parts?offset=${offset}`, {
      method: "PUT",
      body: bytes,
    });
  }

  /** A chunk of bytes whose CONTENT identifies where it came from. */
  function ramp(n: number, from = 0): Uint8Array {
    return Uint8Array.from({ length: n }, (_, at) => (from + at) % 251);
  }

  test("declares an upload readable before a single part has landed", async () => {
    const base = await serve();
    const res = await begin(base, "abc", UPLOAD_CHUNK_BYTES * 2, {
      name: "standup.wav",
      type: "audio/wav",
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      id: "abc",
      name: "standup.wav",
      type: "audio/wav",
      size: 0,
      complete: false,
      url: "/workflows/uploads/abc",
    });
  });

  test("says nothing about a direct byte route by default", async () => {
    // `aai dev` and a self-hosted server hold the bucket credential themselves and
    // serve no such route. The field is OMITTED rather than `false`, because that is
    // also what an agent deployed before any of this existed answers — one shape for
    // "send the body to me", not two.
    const base = await serve();
    const res = await begin(base, "abc", 8);
    await expect(res.json()).resolves.not.toHaveProperty("directParts");
  });

  test("advertises the direct route when the deployment has one", async () => {
    // A CAPABILITY of the deployment, answered by the claim so a client never has to
    // guess it from its own URL — a wrong guess sends megabytes into a 404.
    const base = await serve({ directParts: true });
    const res = await begin(base, "abc", 8);
    await expect(res.json()).resolves.toMatchObject({ directParts: true });
  });

  test("`…/info` answers the same capability the claim does", async () => {
    // Because a RESUME cannot read it from the claim: re-declaring an id the store
    // already holds is answered 409, and a 409 carries no body. Without it here the
    // client falls back to sending bytes to the agent, which works and is the
    // topology the direct path exists to avoid.
    const base = await serve({ directParts: true });
    await begin(base, "abc", 8);
    const res = await fetch(`${base}/workflows/uploads/abc/info`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      directParts: true,
      claimBatch: UPLOAD_CLAIM_BATCH,
    });
  });

  test("`…/info` says nothing about a deployment whose bytes come to the AGENT", async () => {
    const base = await serve();
    await begin(base, "abc", 8);
    const res = await fetch(`${base}/workflows/uploads/abc/info`);
    await expect(res.json()).resolves.not.toHaveProperty("directParts");
  });

  test("`stored=1` records a window without carrying it", async () => {
    // The direct path's write. No body: the bytes went to the platform, and the store
    // measures the object itself rather than trusting anything here.
    const base = await serve({ directParts: true });
    await begin(base, "abc", 8);
    const store = current();
    store.stored.set("abc/0", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const res = await fetch(`${base}/workflows/uploads/abc/parts?offset=0&stored=1`, {
      method: "PUT",
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ size: 8, complete: true });
  });

  test("advertises the claim BATCH alongside the direct route", async () => {
    // A second capability, and it may not be inferred from the first: the two
    // shipped in different versions, and an agent reading one `?offset=` out of a
    // batched claim records the first window and leaves the rest as holes.
    const base = await serve({ directParts: true });
    const res = await begin(base, "abc", 8);
    await expect(res.json()).resolves.toMatchObject({
      directParts: true,
      claimBatch: UPLOAD_CLAIM_BATCH,
    });
  });

  test("does NOT advertise a batch where the bytes come to the agent", async () => {
    // There is no separate claim to batch on that path — the request carrying a
    // window's body is what records it.
    const base = await serve();
    const res = await begin(base, "abc", 8);
    await expect(res.json()).resolves.not.toHaveProperty("claimBatch");
  });

  test("`stored=1` records SEVERAL windows named in one request", async () => {
    // The batch. The claim carries no bytes and cost about half of an upload's wall
    // clock, per part, so naming every window that landed collapses the toll — and
    // the record it leaves is the same one three separate claims would have.
    const base = await serve({ directParts: true });
    await begin(base, "abc", UPLOAD_CHUNK_BYTES + 4);
    const store = current();
    store.stored.set("abc/0", ramp(UPLOAD_CHUNK_BYTES));
    store.stored.set(`abc/${UPLOAD_CHUNK_BYTES}`, ramp(4));
    const res = await fetch(
      `${base}/workflows/uploads/abc/parts?offset=0&offset=${UPLOAD_CHUNK_BYTES}&stored=1`,
      { method: "PUT" },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      size: UPLOAD_CHUNK_BYTES + 4,
      complete: true,
    });
  });

  test("refuses a claim naming more windows than the cap", async () => {
    // The cap is what stops one request asking for unbounded work — a bucket probe
    // and a record write per offset named.
    const base = await serve({ directParts: true });
    await begin(base, "abc", 8);
    const offsets = Array.from(
      { length: UPLOAD_CLAIM_BATCH + 1 },
      (_unused, at) => `offset=${at * UPLOAD_CHUNK_BYTES}`,
    ).join("&");
    const res = await fetch(`${base}/workflows/uploads/abc/parts?${offsets}&stored=1`, {
      method: "PUT",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining(String(UPLOAD_CLAIM_BATCH)),
    });
  });

  test("refuses several offsets beside a BODY, which carries one window", async () => {
    // Only the body-less claim is a list. A second offset next to a body is a caller
    // that composed the wrong request, not one asking for something this route could
    // do — so it is said rather than interpreted.
    const base = await serve();
    await begin(base, "abc", UPLOAD_CHUNK_BYTES * 2);
    // A FOUR-byte body, though the refusal is about the offsets. The route answers
    // before reading the body, so a megabyte here costs three seconds of the suite
    // waiting on a stream nobody drains — which is pre-existing for every refusal on
    // this route and not what this spec is about.
    const res = await fetch(
      `${base}/workflows/uploads/abc/parts?offset=0&offset=${UPLOAD_CHUNK_BYTES}`,
      { method: "PUT", body: ramp(4) },
    );
    expect(res.status).toBe(400);
  });

  test("refuses a claim in which ANY offset is unreadable", async () => {
    // A batch is only as good as its worst member, and a parse that stopped at the
    // first would record one window and silently drop the rest.
    const base = await serve({ directParts: true });
    await begin(base, "abc", 8);
    const res = await fetch(`${base}/workflows/uploads/abc/parts?offset=0&offset=nope&stored=1`, {
      method: "PUT",
    });
    expect(res.status).toBe(400);
  });

  test("`stored=1` is a 400 for a window nobody uploaded", async () => {
    // The whole defence on that path: a client claiming a part it never sent would
    // advance `size` over bytes that are not there, and a step reading them gets
    // SILENCE — a gap in a transcript with nothing anywhere reporting one.
    const base = await serve({ directParts: true });
    await begin(base, "abc", 8);
    const res = await fetch(`${base}/workflows/uploads/abc/parts?offset=0&stored=1`, {
      method: "PUT",
    });
    expect(res.status).toBe(400);
  });

  test("reassembles parts sent AT ONCE and out of order", async () => {
    const base = await serve();
    const total = UPLOAD_CHUNK_BYTES * 3;
    await begin(base, "abc", total);
    // All three in flight together, which is the shape the client really sends —
    // and `Promise.all` settles them in whatever order the server finishes.
    const answers = await Promise.all([
      part(base, "abc", UPLOAD_CHUNK_BYTES * 2, ramp(UPLOAD_CHUNK_BYTES, 2)),
      part(base, "abc", 0, ramp(UPLOAD_CHUNK_BYTES)),
      part(base, "abc", UPLOAD_CHUNK_BYTES, ramp(UPLOAD_CHUNK_BYTES, 1)),
    ]);
    expect(answers.map((one) => one.status)).toEqual([200, 200, 200]);
    const stored = await fetch(`${base}/workflows/uploads/abc/info`);
    await expect(stored.json()).resolves.toMatchObject({ size: total, complete: true });
    // Read across a seam, so this is about the ORDER of the bytes rather than
    // their number.
    const bytes = await fetch(`${base}/workflows/uploads/abc`, {
      headers: { Range: `bytes=${UPLOAD_CHUNK_BYTES - 1}-${UPLOAD_CHUNK_BYTES}` },
    });
    expect([...new Uint8Array(await bytes.arrayBuffer())]).toEqual([
      (UPLOAD_CHUNK_BYTES - 1) % 251,
      1,
    ]);
  });

  test("answers each part with the record AS IT NOW STANDS", async () => {
    const base = await serve();
    await begin(base, "abc", UPLOAD_CHUNK_BYTES * 2);
    // The part that closes the last gap tells its own sender the upload is
    // finished, so a client never has to poll for it.
    const first = await part(base, "abc", 0, ramp(UPLOAD_CHUNK_BYTES));
    await expect(first.json()).resolves.toMatchObject({
      size: UPLOAD_CHUNK_BYTES,
      complete: false,
    });
    const last = await part(base, "abc", UPLOAD_CHUNK_BYTES, ramp(UPLOAD_CHUNK_BYTES));
    await expect(last.json()).resolves.toMatchObject({
      size: UPLOAD_CHUNK_BYTES * 2,
      complete: true,
    });
  });

  test("a declaration with no total is a 400 naming what is missing", async () => {
    const base = await serve();
    const res = await fetch(`${base}/workflows/uploads/abc/parts`, { method: "POST" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("total") });
  });

  test("a part with no offset is a 400 naming what is missing", async () => {
    const base = await serve();
    await begin(base, "abc", UPLOAD_CHUNK_BYTES);
    const res = await fetch(`${base}/workflows/uploads/abc/parts`, {
      method: "PUT",
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("offset") });
  });

  test("a misaligned offset is a 400, not a part stored in the wrong place", async () => {
    const base = await serve();
    await begin(base, "abc", UPLOAD_CHUNK_BYTES);
    const res = await part(base, "abc", 7, ramp(4));
    // 400 rather than a retryable status, because the request will be refused
    // identically every time and a client retrying it is in a loop.
    expect(res.status).toBe(400);
  });

  test("a part for an upload nobody declared is a 404", async () => {
    const base = await serve();
    const res = await part(base, "abc", 0, ramp(4));
    expect(res.status).toBe(404);
  });

  test("a second declaration of one id is a 409, never a re-declaration", async () => {
    const base = await serve();
    await begin(base, "abc", UPLOAD_CHUNK_BYTES);
    expect((await begin(base, "abc", UPLOAD_CHUNK_BYTES)).status).toBe(409);
  });

  test("an id that would escape the store is a 400", async () => {
    const base = await serve();
    const res = await fetch(`${base}/workflows/uploads/..%2Fescape/parts?total=4`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  test("is matched BEFORE `/uploads/:id`, which is a prefix rule", async () => {
    const base = await serve();
    // The order-is-load-bearing rule: listed the other way round, this `PUT` reads
    // `"abc/parts"` as an upload id and stores a whole file under it. The STATUS is
    // what tells the two apart — a part answers 200 where the whole-file route
    // answers 201 — and the window really landing on the declared upload is the
    // other half of the same fact.
    await begin(base, "abc", UPLOAD_CHUNK_BYTES);
    expect((await part(base, "abc", 0, ramp(UPLOAD_CHUNK_BYTES))).status).toBe(200);
    const info = await fetch(`${base}/workflows/uploads/abc/info`);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ id: "abc", size: UPLOAD_CHUNK_BYTES });
    // And the misread id is not merely empty, it is unaskable: every `/uploads/:id`
    // route rejects the grammar before the store sees it, so a 400 rather than the
    // 404 this probe used to read. See `uploadIdOr400`.
    const stored = await fetch(`${base}/workflows/uploads/abc%2Fparts/info`);
    expect(stored.status).toBe(400);
  });

  test("404s with the fix on a server that stores no uploads", async () => {
    const base = await serve({ uploads: undefined });
    expect((await begin(base, "abc", 4)).status).toBe(404);
    expect((await part(base, "abc", 0, ramp(4))).status).toBe(404);
  });
});
