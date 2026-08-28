// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { MAX_CLIENT_EVENT_NAME_LENGTH, MAX_CLIENT_EVENT_PAYLOAD_BYTES } from "./constants.ts";
import { emit, publishStepReporter, report } from "./step-report.ts";
import { publishUploadReader, readUpload, uploadInfo } from "./step-uploads.ts";
import { writeUpload } from "./step-uploads-write.ts";
import {
  createStubWorkflows,
  createToolContext,
  stubReporter,
  stubUploads,
  type TestToolContext,
  type ToolContextOverrides,
} from "./testing.ts";

describe("createToolContext", () => {
  test("supplies every ToolContext field", () => {
    // The reason this helper exists is that a hand-rolled stub omits fields and
    // casts the gap away, so the field list is the assertion.
    const ctx = createToolContext();
    expect(Object.keys(ctx).sort()).toEqual([
      // `db` was first here, and its removal is the point: `ctx.db` is gone, so a
      // helper still supplying one would advertise an API the runtime does not build.
      "delegate",
      "env",
      "generate",
      "messages",
      "send",
      "sent",
      "sessionId",
      "signal",
      "slots",
      "workflows",
    ]);
  });

  test("defaults are inert: empty env, empty slots, no messages", () => {
    const ctx = createToolContext();
    expect(ctx.env).toEqual({});
    expect(ctx.slots.read("anything")).toBeUndefined();
    expect(ctx.messages).toEqual([]);
  });

  test("each call is a distinct session", () => {
    expect(createToolContext().sessionId).not.toBe(createToolContext().sessionId);
  });

  test("an explicit sessionId makes two contexts the same session", () => {
    const a = createToolContext({ sessionId: "s1" });
    const b = createToolContext({ sessionId: "s1" });
    expect(a.sessionId).toBe(b.sessionId);
  });

  test("signal is present and never aborts", () => {
    expect(createToolContext().signal.aborted).toBe(false);
  });

  test("send records into ctx.sent in call order", () => {
    const ctx = createToolContext();
    ctx.send("first", { a: 1 });
    ctx.send("second", "text");
    expect(ctx.sent).toEqual([
      { event: "first", data: { a: 1 } },
      { event: "second", data: "text" },
    ]);
  });

  test("carries NO db, because `ctx.db` no longer exists", () => {
    // It used to default to a `Db` whose every query rejected naming the field.
    // The platform provisions no database and no longer hands one to tool code, so
    // an author who wants SQL brings their own client — and a test context that
    // still offered one would advertise an API the runtime does not build.
    //
    // The ABSENCE is the whole contract here. The "a stale tool will not compile"
    // half is pinned at the type level in `types-inference.test.ts`, which is where
    // it belongs: asserting it at run time needs a double cast to get past the
    // checker, and that cast is exactly what `check:hatches` counts.
    expect("db" in createToolContext()).toBe(false);
  });

  test("generate rejects with a message naming the field", async () => {
    const ctx = createToolContext();
    await expect(ctx.generate({ prompt: "hi" })).rejects.toThrow(/ctx\.generate was not stubbed/);
  });

  test("overrides win over the defaults", () => {
    const ctx = createToolContext({
      sessionId: "fixed",
      env: { API_KEY: "k" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(ctx.sessionId).toBe("fixed");
    expect(ctx.env).toEqual({ API_KEY: "k" });
    expect(ctx.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("an override may be `undefined`, meaning the caller does not have one", () => {
    // The whole point of not taking `Partial<ToolContext>`: under
    // `exactOptionalPropertyTypes` a `string | undefined` cannot be passed to
    // `sessionId?: string`, and the two shipped templates that met that wrote
    // the identical `...(sessionId ? { sessionId } : {})` — the conditional
    // spread this repo's own rule 22 counts as debt.
    const absent: string | undefined = undefined;
    const ctx = createToolContext({ sessionId: absent });
    expect(ctx.sessionId).toMatch(/^test-session-/);
  });

  test("an `undefined` override leaves the DEFAULT, never an undefined field", async () => {
    // Spread naively, `{ ...{ generate: undefined } }` overwrites the rejecting
    // default and the tool under test then dies on a TypeError instead of on the
    // sentence that names the missing stub. (This was written against `db`, which
    // is gone — `generate` is the same shape and the rule is the point.)
    const generate = undefined;
    const ctx = createToolContext({ generate, sessionId: "s" });
    await expect(ctx.generate({ prompt: "hi" })).rejects.toThrow(/ctx\.generate was not stubbed/);
  });

  test("the overrides type accepts `undefined` for every field", () => {
    // A type-level assertion, checked by `tsc` rather than at runtime: every
    // field of the overrides must admit `undefined`, or a caller holding an
    // optional value is back to the conditional spread.
    expectTypeOf<ToolContextOverrides["sessionId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<{ sessionId: string | undefined }>().toExtend<ToolContextOverrides>();
    expectTypeOf(createToolContext({ sessionId: undefined })).toEqualTypeOf<TestToolContext>();
  });

  test("does not record an event the runtime would drop", () => {
    // The recorder used to accept everything, so a spec could assert a
    // notification that never left the process: `sent` said it was sent and
    // the browser never saw it. The rule is `decideClientEvent`'s, shared with
    // the runtime, so the two cannot disagree about what reaches a client.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = createToolContext();
    ctx.send("fits", { a: 1 });
    ctx.send("too_big", { blob: "x".repeat(MAX_CLIENT_EVENT_PAYLOAD_BYTES) });
    ctx.send("x".repeat(MAX_CLIENT_EVENT_NAME_LENGTH + 1), 1);
    ctx.send("not_json", () => 1);
    expect(ctx.sent).toEqual([{ event: "fits", data: { a: 1 } }]);
    // Announced, not silent: an empty `sent` with no reason is the same
    // debugging problem one layer down.
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining("too-large"),
      expect.stringContaining("name-too-long"),
      expect.stringContaining("no-json-form"),
    ]);
  });

  test("a cyclic payload is dropped rather than thrown, as in production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = createToolContext();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // A throw here would fail the whole tool call in a spec while production
    // carries on — the tool body is the caller.
    expect(() => ctx.send("cycle", cyclic)).not.toThrow();
    expect(ctx.sent).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain("unserializable");
  });

  test("a spy passed as send replaces the recorder", () => {
    const send = vi.fn();
    const ctx = createToolContext({ send });
    ctx.send("evt", 1);
    expect(send).toHaveBeenCalledWith("evt", 1);
    // The recorder is bypassed, not silently mirrored — `sent` would otherwise
    // read as a second, disagreeing record of what the tool did.
    expect(ctx.sent).toEqual([]);
  });

  test("an aborted signal can be supplied for cancellation tests", () => {
    const controller = new AbortController();
    controller.abort();
    expect(createToolContext({ signal: controller.signal }).signal.aborted).toBe(true);
  });

  test("its slot store applies the real storability check", () => {
    // NOT a stub: a template holding a `Map` in a slot has to fail in its own
    // spec rather than on the first deployment that has a database.
    const ctx = createToolContext();
    expect(() => ctx.slots.write("held", new Map(), true)).toThrow(/a Map/);
  });

  test("two contexts are two sessions, so their slots are independent", () => {
    const a = createToolContext();
    const b = createToolContext();
    a.slots.write("cart", { items: ["apple"] }, true);
    expect(b.slots.read("cart")).toBeUndefined();
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe("createStubWorkflows", () => {
  test("an unstubbed method rejects naming itself rather than being undefined", async () => {
    const workflows = createStubWorkflows();
    await expect(workflows.start("digest", {})).rejects.toThrow(/not stubbed/);
    await expect(workflows.wakeUp("wrun_1")).rejects.toThrow(/not stubbed/);
    await expect(workflows.stream("wrun_1")).rejects.toThrow(/not stubbed/);
  });

  test("overrides win", async () => {
    const workflows = createStubWorkflows({ start: async () => "wrun_7" });
    await expect(workflows.start("digest", {})).resolves.toBe("wrun_7");
  });

  test("listing answers an empty list rather than throwing", () => {
    // Synchronous, so it cannot reject — and "this app declares none" is a
    // truthful answer for a stub.
    expect(createStubWorkflows().listing()).toEqual([]);
  });

  test("every method of the client is present", () => {
    // The whole point: a method added to `WorkflowClient` must arrive here
    // rather than being left `undefined` for whatever reaches it. Asserted as a
    // count-free presence check over the object's own keys, so this cannot pass
    // by the stub quietly shrinking.
    const workflows = createStubWorkflows();
    for (const [name, value] of Object.entries(workflows)) {
      expect(typeof value, name).toBe("function");
    }
    expect(Object.keys(workflows).sort()).toEqual([
      "cancel",
      "find",
      "get",
      "lastLine",
      "listing",
      "publicWebhookUrl",
      "recent",
      "signal",
      "start",
      "stream",
      "streamTail",
      "wakeUp",
    ]);
  });

  test("publicWebhookUrl THROWS rather than answering an empty string", () => {
    // The other synchronous method, and it gets the opposite treatment from
    // `listing` above: there is no truthful empty answer for a URL, so a stub
    // that has not been given one must say so rather than hand back something a
    // test would then assert about.
    expect(() => createStubWorkflows().publicWebhookUrl("t")).toThrow(/not stubbed/);
  });
});

describe("stubReporter", () => {
  afterEach(() => publishStepReporter(undefined));

  test("separates the SENTENCES from the CHUNKS, the way the streams are", async () => {
    // The split is the helper's whole value: a spec asserting a partial result
    // never has to filter the narration out of it, and the test it applies is
    // the same one `emit()`'s contract rests on — an absent namespace is the
    // default stream, which is `report()`'s.
    const reported = stubReporter();
    await report("Transcribing 0:00–0:58.");
    await emit("transcript", { index: 0, text: "hello" });
    await report("Transcribed 0:00–0:58 in 4.2s.");

    expect(reported.lines).toEqual(["Transcribing 0:00–0:58.", "Transcribed 0:00–0:58 in 4.2s."]);
    expect(reported.emitted).toEqual([
      { namespace: "transcript", chunk: { index: 0, text: "hello" } },
    ]);
  });

  test("keeps chunks from different streams apart, and in order", async () => {
    const reported = stubReporter();
    await emit("transcript", "one");
    await emit("costs", { usd: 0.02 });
    await emit("transcript", "two");
    expect(reported.emitted.map((one) => one.namespace)).toEqual([
      "transcript",
      "costs",
      "transcript",
    ]);
  });

  test("restore unpublishes, so it cannot answer the next file's steps", async () => {
    const reported = stubReporter();
    reported.restore();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await report("after");
    expect(reported.lines).toEqual([]);
    // Back to the console fallback, which is what an unpublished slot means.
    expect(spy).toHaveBeenCalled();
  });
});

describe("stubUploads", () => {
  afterEach(() => publishUploadReader(undefined));

  test("serves the files it was given to a step's reader", async () => {
    stubUploads({ upl_1: new Uint8Array([1, 2, 3]) });

    await expect(uploadInfo("upl_1")).resolves.toMatchObject({ size: 3, complete: true });
    expect([...(await readUpload("upl_1")).bytes]).toEqual([1, 2, 3]);
  });

  test("is READ-ONLY by default, so a step that writes cannot do so unnoticed", async () => {
    stubUploads({ upl_1: new Uint8Array([1]) });

    await expect(writeUpload(new Uint8Array([9]))).rejects.toThrow("read-only");
  });

  test("`writable` mints assertable ids and makes what was written readable", async () => {
    stubUploads({}, { writable: true });

    const stored = await writeUpload(new Uint8Array([4, 5]), {
      name: "summary.wav",
      type: "audio/wav",
    });

    expect(stored).toEqual({
      id: "upl_stub_1",
      name: "summary.wav",
      type: "audio/wav",
      size: 2,
      complete: true,
    });
    expect([...(await readUpload(stored.id)).bytes]).toEqual([4, 5]);
  });

  test("counts up, so two writes in one run are distinguishable", async () => {
    stubUploads({}, { writable: true, idPrefix: "wav_" });

    const first = await writeUpload(new Uint8Array([1]));
    const second = await writeUpload(new Uint8Array([2]));

    expect([first.id, second.id]).toEqual(["wav_1", "wav_2"]);
  });

  test("records what a step WROTE, so no spec has to read it back through the slot", async () => {
    // The round trip this replaces: `writeUpload` then `uploadInfo`/`readUpload`
    // on the id it returned, through the same published seam the step used, to
    // answer "did it write anything at all".
    const uploads = stubUploads({}, { writable: true });

    await writeUpload(new Uint8Array([4, 5]), { name: "summary.wav", type: "audio/wav" });

    expect(uploads.writes).toEqual([
      { id: "upl_stub_1", name: "summary.wav", type: "audio/wav", bytes: new Uint8Array([4, 5]) },
    ]);
  });

  test("a read-only store records no writes, because it accepted none", async () => {
    const uploads = stubUploads({ upl_1: new Uint8Array([1]) });

    await expect(writeUpload(new Uint8Array([9]))).rejects.toThrow("read-only");
    expect(uploads.writes).toEqual([]);
  });

  test("`read` answers for a seeded file too, synchronously and outside the slot", () => {
    const uploads = stubUploads({ upl_1: { bytes: new Uint8Array([7]), name: "a.wav" } });

    expect(uploads.read("upl_1")).toEqual({
      id: "upl_1",
      name: "a.wav",
      type: "",
      bytes: new Uint8Array([7]),
    });
    expect(uploads.read("upl_nope")).toBeUndefined();
  });

  test("`restore` unpublishes, so the next file's steps do not read these bytes", async () => {
    const uploads = stubUploads({ upl_1: new Uint8Array([1]) });
    uploads.restore();

    // Nothing published: the reader reports there is no store rather than
    // answering with the last file's.
    await expect(uploadInfo("upl_1")).rejects.toThrow();
  });
});
