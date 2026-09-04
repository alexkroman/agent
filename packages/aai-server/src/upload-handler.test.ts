// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `PUT/GET/HEAD /:slug/uploads/:id/:offset`.
 *
 * Driven through the real orchestrator app, because two of the three things worth
 * asserting are properties of the ROUTE rather than of the handler: that a caller
 * cannot address a key outside its own agent's prefix, and that this route is reached
 * without brokering a sandbox — a forward would defeat the whole point, which is that
 * an upload byte never touches a guest.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { UPLOAD_PART_BYTES } from "@alexkroman1/aai-runtime/internal";
import { describe, expect, test } from "vitest";
import { createOrchestrator } from "./orchestrator.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { createTestStore, fakeAdminDbOver } from "./test-utils.ts";
import { createMemoryUploadBytes, type UploadBytes, uploadKey } from "./upload-bytes.ts";
import { MAX_UPLOAD_WINDOW_BYTES } from "./upload-handler.ts";

/**
 * The app plus the byte store behind it, so a spec can look at what really landed.
 *
 * The agents are SEEDED, because a write requires the slug to name one — see
 * `assertAgentExists`. Nothing brokers as a result: an agents-row read is not a
 * sandbox, which is the property the last spec here pins.
 */
async function serve(
  bytes: UploadBytes = createMemoryUploadBytes(),
  record: Record<string, unknown> | null = null,
) {
  const store = createTestStore();
  // `null` is the ordinary case here and means NO platform database, which is what
  // every spec below the record ones is written against — see
  // `UploadBytesHandlerOptions.adminDb`.
  const adminDb =
    record === null
      ? undefined
      : fakeAdminDbOver((sql) =>
          sql.includes("from aai_platform.workflow_uploads") ? [record] : [],
        );
  const { app } = createOrchestrator({
    slots: createSlotCache(),
    store,
    uploadBytes: bytes,
    ...omitUndefined({ adminDb }),
  });
  for (const slug of DEPLOYED) {
    await store.putAgent({
      slug,
      env: {},
      worker: "export default {};",
      clientFiles: {},
      credential_hashes: [],
    });
  }
  const call = async (path: string, init?: RequestInit): Promise<Response> =>
    await app.request(`http://platform.test${path}`, init);
  return { bytes, call };
}

/** The slugs every spec here writes under, deployed by {@link serve}. */
const DEPLOYED = ["desk", "digest-desk"] as const;

/** `n` bytes counting up, so a window's CONTENT identifies its offset. */
function ramp(n: number, from = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, at) => (from + at) % 251);
}

/** One buffer as the iterable `UploadBackend.put` takes. */
async function* once(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

describe("a window of upload bytes", () => {
  test("PUT stores it under the agent's OWN prefix", async () => {
    const { bytes, call } = await serve();
    const res = await call("/digest-desk/uploads/upl_abc/0", {
      method: "PUT",
      body: ramp(64),
      headers: { "Content-Type": "audio/wav" },
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ bytes: 64 });
    // The key is composed HERE from the slug Hono matched, never from anything the
    // caller sent — which is what stops one agent addressing another's objects in a
    // bucket every tenant shares.
    expect(await bytes.size(uploadKey("digest-desk", "upl_abc", 0))).toBe(64);
  });

  test("GET answers the bytes when the backend cannot sign", async () => {
    // The memory backend has no server in front of it, so `readUrl` is null and the
    // route serves the window itself — the path `aai dev` and the tests take.
    const { call } = await serve();
    await call("/desk/uploads/upl_abc/0", { method: "PUT", body: ramp(64) });
    const res = await call("/desk/uploads/upl_abc/0");
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...ramp(64)]);
  });

  test("GET honours a Range, because the reader is a fan-out", async () => {
    const { call } = await serve();
    await call("/desk/uploads/upl_abc/0", { method: "PUT", body: ramp(64) });
    const res = await call("/desk/uploads/upl_abc/0", { headers: { Range: "bytes=8-11" } });
    expect(res.status).toBe(206);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...ramp(4, 8)]);
  });

  test("GET REDIRECTS when the backend can sign, so bytes skip the platform", async () => {
    // The property that keeps a sixty-step fan-out from moving a 200 MB recording
    // through this process once per run. A 302 carries no body and `fetch` follows it
    // with the `Range` header intact.
    const signing: UploadBytes = {
      ...createMemoryUploadBytes(),
      readUrl: (key) => Promise.resolve(`https://storage.test/${key}?token=t`),
    };
    const { call } = await serve(signing);
    const res = await call("/desk/uploads/upl_abc/0", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://storage.test/uploads/desk/upl_abc/0?token=t");
  });

  test("HEAD answers the length, and 404 for a window nobody wrote", async () => {
    // Answered here rather than redirected: it is one number, and a 302 would cost a
    // second round trip to learn it. `size` never over-reporting is what lets the
    // agent refuse a part nobody uploaded.
    const { call } = await serve();
    await call("/desk/uploads/upl_abc/0", { method: "PUT", body: ramp(64) });
    const found = await call("/desk/uploads/upl_abc/0", { method: "HEAD" });
    expect(found.status).toBe(200);
    expect(found.headers.get("content-length")).toBe("64");
    expect((await call("/desk/uploads/upl_abc/8", { method: "HEAD" })).status).toBe(404);
  });

  test("GET is a 404 for a window nobody wrote, not an empty 200", async () => {
    const { call } = await serve();
    expect((await call("/desk/uploads/upl_abc/0")).status).toBe(404);
  });

  test("refuses an id that is not one, before composing a key from it", async () => {
    const { bytes, call } = await serve();
    const res = await call("/desk/uploads/..%2F..%2Fblobs%2Fdeadbeef/0", {
      method: "PUT",
      body: ramp(4),
    });
    // 400 rather than a stored object: the id is part of a key, and the one thing this
    // route must never do is let a caller name `blobs/<hash>` — every tenant's worker
    // bundle lives under that prefix in the same bucket.
    expect(res.status).toBe(400);
    expect(await bytes.size("blobs/deadbeef")).toBeUndefined();
  });

  test("refuses an offset that is not a byte position", async () => {
    const { call } = await serve();
    expect((await call("/desk/uploads/upl_abc/-8", { method: "PUT", body: ramp(4) })).status).toBe(
      400,
    );
    expect((await call("/desk/uploads/upl_abc/1e9", { method: "PUT", body: ramp(4) })).status).toBe(
      400,
    );
  });

  test("caps a WINDOW rather than a file, which is a different number", async () => {
    // `MAX_WORKFLOW_UPLOAD_BYTES` (2 GiB) bounds a FILE and a file is many windows, so
    // it is the wrong cap here. This one is an order of magnitude above what the client
    // sends, so anything past it is a caller doing something else entirely.
    expect(MAX_UPLOAD_WINDOW_BYTES).toBeGreaterThan(UPLOAD_PART_BYTES);
    const { call } = await serve();
    const res = await call("/desk/uploads/upl_abc/0", {
      method: "PUT",
      body: new Uint8Array(MAX_UPLOAD_WINDOW_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });

  test("does not broker a sandbox, which is the whole point of the route", async () => {
    // The orchestrator here is built with NO guest fetch and no sandbox backend, so a
    // route that brokered would answer 404 or 503 rather than storing anything. This
    // one answers 201 and the bytes are in the bucket, because no guest is involved at
    // any point — they go from the caller straight to storage and the agent is told
    // afterwards. (This used to be proven with an UNDEPLOYED slug, which conflated
    // "does not broker" with "does not check the agent exists" — see below.)
    const { bytes, call } = await serve();
    const res = await call("/desk/uploads/upl_abc/0", { method: "PUT", body: ramp(4) });
    expect(res.status).toBe(201);
    expect(await bytes.size(uploadKey("desk", "upl_abc", 0))).toBe(4);
  });

  test("REFUSES a write under a slug no agent answers to", async () => {
    // Measured against production before this guard existed: `PUT
    // /no-such-agent-here/uploads/upl_x/0` answered 201 and put bytes at
    // `uploads/no-such-agent-here/upl_x/0`. `slugMw` validates a slug's shape and its
    // reserved names, never its existence — so an unauthenticated caller could mint
    // unbounded prefixes in a bucket shared by every tenant, and `aai-sweep-blob-gc`
    // matched `blobs/%` so nothing reclaimed them. That second half is closed too
    // now — the GC has an uploads arm — but this guard is what keeps the number of
    // prefixes bounded rather than merely the lifetime of each.
    const { bytes, call } = await serve();
    const res = await call("/never-deployed/uploads/upl_abc/0", { method: "PUT", body: ramp(4) });
    expect(res.status).toBe(404);
    // And nothing landed — the refusal is BEFORE the write, not a status over one.
    expect(await bytes.size(uploadKey("never-deployed", "upl_abc", 0))).toBeUndefined();
  });

  test("REFUSES a write to a window of a COMPLETE upload", async () => {
    // The rewrite primitive, measured before this guard: a second PUT at a window a
    // run is about to read answered 201 and swapped the bytes under it — longer,
    // shorter or the same length — while the RECORD kept its `size` and `complete`,
    // so no reader had anything to notice. Unauthenticated, and an upload id is the
    // caller's own choice, so it needed only a slug from a URL.
    const { bytes, call } = await serve(createMemoryUploadBytes(), {
      name: "clip.wav",
      type: "audio/wav",
      size: "4",
      complete: true,
      expected: "4",
      parts: [{ at: 0, bytes: 4 }],
    });
    const key = uploadKey("desk", "upl_abc", 0);
    // The window as the finished upload holds it. Written straight to the store,
    // because the route is what this spec is about.
    await bytes.put(key, once(ramp(4)), { limit: 64 });
    const res = await call("/desk/uploads/upl_abc/0", { method: "PUT", body: ramp(64, 100) });
    // 409 rather than 403: the request is well formed and the resource is closed,
    // which is also what keeps a client from retrying it — 409 is in neither
    // `RETRYABLE_STATUS` nor the resume vocabulary.
    expect(res.status).toBe(409);
    expect(await bytes.size(key)).toBe(4);
    expect([...(await bytes.read(key, 0, 4))]).toEqual([...ramp(4)]);
  });

  test("still writes a window while the upload is ARRIVING", async () => {
    // The flow a blanket refusal would have broken, and it is the documented one: a
    // window is re-sent as ONE unit after a transport failure whose response may have
    // been lost, and a resumed upload re-sends a window whose bytes landed but whose
    // CLAIM did not — the only repair that leaves the record and the bucket agreeing.
    // Both act on an upload that is not complete.
    const { bytes, call } = await serve(createMemoryUploadBytes(), {
      name: "clip.wav",
      type: "audio/wav",
      size: "0",
      complete: false,
      expected: "8",
      parts: [{ at: 0, bytes: 4 }],
    });
    const key = uploadKey("desk", "upl_abc", 0);
    await bytes.put(key, once(ramp(4)), { limit: 64 });
    const res = await call("/desk/uploads/upl_abc/0", { method: "PUT", body: ramp(4, 100) });
    expect(res.status).toBe(201);
    expect([...(await bytes.read(key, 0, 4))]).toEqual([...ramp(4, 100)]);
  });

  test("a completed upload's window is still READABLE", async () => {
    // The refusal is on the WRITE only. A read of a finished upload is the ordinary
    // case — it is what every step does — so a guard that touched GET or HEAD would
    // break the feature rather than protect it.
    const { bytes, call } = await serve(createMemoryUploadBytes(), {
      name: "clip.wav",
      type: "",
      size: "4",
      complete: true,
      expected: "4",
      parts: [{ at: 0, bytes: 4 }],
    });
    await bytes.put(uploadKey("desk", "upl_abc", 0), once(ramp(4)), { limit: 64 });
    expect((await call("/desk/uploads/upl_abc/0")).status).toBe(200);
    expect((await call("/desk/uploads/upl_abc/0", { method: "HEAD" })).status).toBe(200);
  });

  test("writes when there is NO record, because `create` writes its row last", async () => {
    // `POST /workflows/uploads` stores every window before it inserts anything, so
    // during that upload there is no row to consult. A rule of "no record, no write"
    // would refuse the whole route for it.
    const { bytes, call } = await serve(createMemoryUploadBytes(), null);
    const res = await call("/desk/uploads/upl_new/0", { method: "PUT", body: ramp(4) });
    expect(res.status).toBe(201);
    expect(await bytes.size(uploadKey("desk", "upl_new", 0))).toBe(4);
  });

  test("still READS without a lookup, because a miss already answers", async () => {
    // Reads are the fan-out — sixty steps each taking their own window — so gating them
    // would be sixty queries a run to establish what a 404 reports anyway. An unknown
    // slug simply has no objects.
    const { call } = await serve();
    const res = await call("/never-deployed/uploads/upl_abc/0");
    expect(res.status).toBe(404);
  });
});

/**
 * The unsigned arm — memory bytes, i.e. `aai dev` and these specs. Production
 * redirects to a signed URL and moves nothing, so what is asserted here is that
 * the fallback stays cheap rather than that it is the normal path.
 */
describe("the unsigned read arm", () => {
  /** Memory bytes that count what the handler actually asked for. */
  function countingBytes() {
    const inner = createMemoryUploadBytes();
    const calls: string[] = [];
    const bytes: UploadBytes = {
      ...inner,
      read: (key, start, end) => {
        calls.push(`read(${start},${end})`);
        return inner.read(key, start, end);
      },
      size: (key) => {
        calls.push("size");
        return inner.size(key);
      },
    };
    return { bytes, calls };
  }

  test("a missing window is one lookup, not a read and then a lookup", async () => {
    const { bytes, calls } = countingBytes();
    const { call } = await serve(bytes);

    expect((await call("/desk/uploads/upl_nothinghere/0")).status).toBe(404);
    expect(calls).toEqual(["size"]);
  });

  test("a rangeless read is bounded by the object, not by MAX_SAFE_INTEGER", async () => {
    // The end used to be `Number.MAX_SAFE_INTEGER`, which asks the store for
    // everything and leans on it to clamp — on a route whose window cap is 64 MiB.
    const { bytes, calls } = countingBytes();
    const { call } = await serve(bytes);
    await call("/desk/uploads/upl_sized/0", { method: "PUT", body: ramp(32) });
    calls.length = 0;

    const res = await call("/desk/uploads/upl_sized/0");
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...ramp(32)]);
    expect(calls).toEqual(["size", "read(0,32)"]);
  });

  test("a Range still narrows it", async () => {
    const { bytes, calls } = countingBytes();
    const { call } = await serve(bytes);
    await call("/desk/uploads/upl_ranged/0", { method: "PUT", body: ramp(64) });
    calls.length = 0;

    const res = await call("/desk/uploads/upl_ranged/0", { headers: { range: "bytes=4-7" } });
    expect(res.status).toBe(206);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...ramp(4, 4)]);
    expect(calls).toEqual(["size", "read(4,8)"]);
  });
});
