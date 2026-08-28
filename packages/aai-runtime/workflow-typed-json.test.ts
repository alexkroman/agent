// Copyright 2026 the AAI authors. MIT license.
/**
 * The wire codec both sides of platform-owned run storage use.
 *
 * The bug this exists to prevent is SILENT. At `specVersion >= 2` a run's `input`
 * and `output`, a step's `input` and `output`, and a hook's `metadata` are
 * `Uint8Array`; plain `JSON.stringify` turns one into `{"0":7,"1":0}` and
 * `JSON.parse` hands that object back. Nothing throws — the run just starts with
 * garbage, and the first sign of it is devalue failing to deserialize, several
 * layers from the cause.
 *
 * So the property that matters is a ROUND TRIP through the real
 * `JSON.stringify`/`JSON.parse`, at the nesting depth their entities actually use.
 */

import { describe, expect, test } from "vitest";
import {
  decodeStorageJson,
  decodeTypedJson,
  encodeStorageJson,
  encodeTypedJson,
} from "./workflow-typed-json.ts";

/** Encode then decode, which is what crossing the wire does. */
const roundTrip = (value: unknown): unknown => decodeTypedJson(encodeTypedJson(value));

/** The same, over the storage RPC's codec, which also carries dates. */
const storageRoundTrip = (value: unknown): unknown => decodeStorageJson(encodeStorageJson(value));

describe("ordinary JSON values", () => {
  test.each([
    ["a string", "hello"],
    ["a number", 42],
    ["zero", 0],
    ["a negative", -1],
    ["true", true],
    ["false", false],
    ["null", null],
    ["an empty object", {}],
    ["an empty array", []],
    ["a nested record", { a: { b: [1, "two", null] } }],
  ])("survives %s unchanged", (_label, value) => {
    expect(roundTrip(value)).toEqual(value);
  });

  test("drops undefined the way JSON does, rather than inventing a tag", () => {
    // Their entities use `undefined` for absent optional fields, and JSON has no
    // representation for it. Encoding one as a tagged value would make an absent
    // field present-and-undefined, which reads differently to a zod schema.
    expect(roundTrip({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});

describe("binary, which is the whole point", () => {
  test("a Uint8Array comes back as a Uint8Array, not an index map", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const back = roundTrip(bytes);
    expect(back).toBeInstanceOf(Uint8Array);
    expect(back).toEqual(bytes);
  });

  test("plain JSON.parse(JSON.stringify(...)) does NOT, which is the bug", () => {
    // Spelled out so the reason this module exists is visible rather than asserted.
    const bytes = new Uint8Array([7, 0, 255]);
    const naive: unknown = JSON.parse(JSON.stringify(bytes));
    expect(naive).not.toBeInstanceOf(Uint8Array);
    expect(naive).toEqual({ "0": 7, "1": 0, "2": 255 });
  });

  test("an empty Uint8Array survives, and is not confused with absent", () => {
    const back = roundTrip(new Uint8Array([]));
    expect(back).toBeInstanceOf(Uint8Array);
    expect((back as Uint8Array).length).toBe(0);
  });

  /**
   * A `Buffer` IS a `Uint8Array`, and it has to be covered: the Postgres world
   * hands `Buffer`s back for every column it reads as `bytea`.
   */
  test("a Buffer is carried as binary too", () => {
    const back = roundTrip(Buffer.from("devalue bytes"));
    expect(back).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(back as Uint8Array).toString()).toBe("devalue bytes");
  });

  /**
   * The case a hand-written walk gets wrong.
   *
   * `Buffer.from(view)` copies rather than aliasing, so a view into a larger
   * allocation encodes ITS OWN bytes — not the whole allocation, which would be
   * both wrong and a data leak.
   */
  test("a VIEW into a larger buffer carries only its own bytes", () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = backing.subarray(2, 5);
    const back = roundTrip(view) as Uint8Array;
    expect(Array.from(back)).toEqual([3, 4, 5]);
  });

  test("binary NESTED where their entities really put it", () => {
    // `events.create(runId, { type: "run_created", runInput: { input } })` is the
    // shape that matters most: the run's input is two levels down.
    const value = {
      type: "run_created",
      runInput: { input: new Uint8Array([9, 9]), workflowName: "w", specVersion: 3 },
    };
    const back = roundTrip(value) as typeof value;
    expect(back.runInput.input).toBeInstanceOf(Uint8Array);
    expect(back.runInput.input).toEqual(value.runInput.input);
    expect(back.runInput.workflowName).toBe("w");
  });

  test("binary inside an ARRAY, which a paginated reply is", () => {
    // `runs.list` answers `{ data: [run, run] }`, each run carrying input/output.
    const value = {
      data: [
        { runId: "r1", input: new Uint8Array([1]), output: new Uint8Array([2]) },
        { runId: "r2", input: new Uint8Array([3]) },
      ],
    };
    const back = roundTrip(value) as typeof value;
    expect(back.data[0]?.input).toBeInstanceOf(Uint8Array);
    expect(back.data[0]?.output).toEqual(new Uint8Array([2]));
    expect(back.data[1]?.input).toEqual(new Uint8Array([3]));
  });

  test("several distinct arrays do not alias each other", () => {
    const back = roundTrip([new Uint8Array([1]), new Uint8Array([2])]) as Uint8Array[];
    expect(back[0]).toEqual(new Uint8Array([1]));
    expect(back[1]).toEqual(new Uint8Array([2]));
  });

  /**
   * The two ARRAY cases above use `Uint8Array`, and that is exactly why the
   * `Buffer` version of them went unnoticed: only `Buffer` carries a `toJSON`,
   * so only `Buffer` needs the replacer to look past `value` at the holder — and
   * the holder guard was `isRecord`, which answers false for an array. A plain
   * `Uint8Array` in an array round-tripped fine while a `Buffer` in one came back
   * as `{type:"Buffer",data:[…]}`, the very shape this module exists to prevent.
   */
  test("a Buffer inside an ARRAY is carried as binary, not as Buffer's own toJSON", () => {
    // What `streamer.writeToStreamMulti(name, runId, chunks)` really passes when
    // the author is on Node, and what any DevKit method answering a list of
    // `bytea` columns hands back.
    const back = roundTrip({ chunks: [Buffer.from([1, 2, 3]), Buffer.from([4])] }) as {
      chunks: Uint8Array[];
    };
    expect(back.chunks[0]).toBeInstanceOf(Uint8Array);
    expect(back.chunks[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(back.chunks[1]).toEqual(new Uint8Array([4]));
  });

  test("a Buffer at the top of an array, where the holder is the array itself", () => {
    const back = roundTrip([Buffer.from("a"), Buffer.from("b")]) as Uint8Array[];
    expect(back[0]).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(back[0] as Uint8Array).toString()).toBe("a");
    expect(Buffer.from(back[1] as Uint8Array).toString()).toBe("b");
  });

  test("a Buffer nested in an object inside an array", () => {
    const value = { data: [{ runId: "r1", output: Buffer.from([7]) }] };
    const back = roundTrip(value) as { data: { runId: string; output: Uint8Array }[] };
    expect(back.data[0]?.output).toBeInstanceOf(Uint8Array);
    expect(back.data[0]?.output).toEqual(new Uint8Array([7]));
  });
});

describe("the format is the DevKit's own", () => {
  /**
   * Matching their envelope is deliberate: their `createQueueHandler` — which the
   * composition keeps — reads queue bodies with exactly this reviver, so a second
   * format would mean two encodings of the same values in one process.
   */
  test("encodes to their tagged envelope, base64 and all", () => {
    const encoded = JSON.parse(encodeTypedJson({ x: new Uint8Array([1, 2]) })) as {
      x: { __type: string; data: string };
    };
    expect(encoded.x.__type).toBe("Uint8Array");
    expect(encoded.x.data).toBe(Buffer.from([1, 2]).toString("base64"));
  });

  test("revives an envelope written by anything else in that format", () => {
    // A payload the DevKit's own transport produced, decoded by ours.
    const theirs = '{"input":{"__type":"Uint8Array","data":"AQI="}}';
    const back = decodeTypedJson(theirs) as { input: unknown };
    expect(back.input).toEqual(new Uint8Array([1, 2]));
  });

  test.each([
    ["a wrong __type", '{"x":{"__type":"Buffer","data":"AQI="}}'],
    ["no data field", '{"x":{"__type":"Uint8Array"}}'],
    ["non-string data", '{"x":{"__type":"Uint8Array","data":7}}'],
  ])("leaves %s alone rather than guessing", (_label, text) => {
    // A value that only half-matches is somebody's ordinary object, and turning it
    // into bytes would corrupt it.
    const back = decodeTypedJson(text) as { x: unknown };
    expect(back.x).not.toBeInstanceOf(Uint8Array);
  });
});

describe("malformed input", () => {
  test.each(["", "not json", "{", '{"a":}'])(
    "throws on %o rather than returning undefined",
    (text) => {
      // Both callers need this: the guest fails the step that was reading, and the
      // platform answers 400. Neither should guess at a value.
      expect(() => decodeTypedJson(text)).toThrow();
    },
  );
});

describe("the withPlainViews pre-pass", () => {
  // `encodeTypedJson` swaps every `Buffer` for a plain `Uint8Array` view before
  // `JSON.stringify` can call `Buffer.prototype.toJSON` — see that function's doc
  // for what the discarded byte array costs. These cover what the swap must NOT
  // break, which is the whole risk of a walk that rebuilds the structure.

  test("a Buffer that is a WINDOW into a pool carries only its OWN bytes", () => {
    // The one that would be a data leak rather than a slowdown: Node's pooled
    // buffers are views into a shared 8 KiB allocation, so a view rebuilt without
    // `byteOffset`/`byteLength` would carry whatever else is in the pool.
    const pool = Buffer.alloc(64, 9);
    const window = pool.subarray(8, 12);
    window.fill(3);
    const back = roundTrip({ b: window }) as { b: Uint8Array };
    expect([...back.b]).toEqual([3, 3, 3, 3]);
  });

  test("a Date survives — the pre-pass must not rebuild a class instance", () => {
    // `isRecord(new Date())` is true and `Object.keys` of one is empty, so a walk
    // that structurally copied every record would erase it. `isPlainObject`'s
    // prototype test is what prevents that.
    const when = new Date("2026-01-02T03:04:05.000Z");
    expect(roundTrip({ when })).toEqual({ when: "2026-01-02T03:04:05.000Z" });
  });

  test("a Buffer reached only through a class instance still encodes", () => {
    // The pre-pass declines to rebuild the instance, so `toJSON` fires and
    // `binaryReplacer`'s holder read handles it exactly as it did before the
    // pre-pass existed. The worst case of the optimization is the old behaviour.
    class Holder {
      readonly bytes: Buffer;
      constructor(bytes: Buffer) {
        this.bytes = bytes;
      }
    }
    const back = roundTrip({ h: new Holder(Buffer.from([1, 2])) }) as {
      h: { bytes: Uint8Array };
    };
    expect([...back.h.bytes]).toEqual([1, 2]);
  });

  test("a cycle still throws stringify's own error, not a stack overflow", () => {
    // The pre-pass recurses, so without its depth cap this would blow the stack
    // before `JSON.stringify` could report the real problem.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeTypedJson(cyclic)).toThrow(/circular/i);
  });

  test("binary nested deeper than the walk cap still round-trips", () => {
    // Past the cap the pre-pass hands the value back untouched, which is not a
    // failure: `toJSON` fires and the replacer covers it.
    let node: Record<string, unknown> = { b: Buffer.from([1]) };
    for (let i = 0; i < 60; i += 1) node = { next: node };
    let seen = roundTrip(node) as Record<string, unknown>;
    for (let i = 0; i < 60; i += 1) seen = seen.next as Record<string, unknown>;
    expect([...(seen.b as Uint8Array)]).toEqual([1]);
  });

  test("a binary-free value is returned unchanged, not copied", () => {
    // The allocation-free path: a payload with no binary in it must come back as
    // the IDENTICAL object, which is what keeps the common reply cheap.
    const plain = { data: [{ id: "r1" }, { id: "r2" }], cursor: null };
    expect(roundTrip(plain)).toEqual(plain);
  });
});

describe("dates", () => {
  /**
   * The regression this whole branch exists for. Their schema declares
   * `timestamp('started_at')`, drizzle reads it in `mode: 'date'`, and the guest's
   * runtime then computes `+run.startedAt` — so a `Date` that crossed as an ISO
   * STRING became `NaN`, which `JSON.stringify` writes into the enqueued step
   * payload as `null`, which the guest's own step handler rejects with
   * `workflowStartedAt: expected number, received null`. Every durable run on the
   * platform stalled at `step_created`.
   */
  test("survives as a Date, so +date is still a number", () => {
    const startedAt = new Date("2026-08-28T03:39:33.132Z");
    const back = storageRoundTrip({ startedAt }) as { startedAt: Date };
    expect(back.startedAt).toBeInstanceOf(Date);
    expect(back.startedAt.getTime()).toBe(startedAt.getTime());
  });

  test("is not fooled by toJSON, which runs BEFORE the replacer", () => {
    // The same hazard `Buffer` has: by the time the replacer sees the value it is
    // already an ISO string, so only the holder can say what was really there.
    const encoded = JSON.parse(encodeStorageJson({ at: new Date(0) })) as {
      at: { __type: string; iso: string };
    };
    expect(encoded.at.__type).toBe("Date");
    expect(encoded.at.iso).toBe("1970-01-01T00:00:00.000Z");
  });

  test.each([
    ["in an array", { chunks: [new Date(0)] }],
    ["nested in a record", { run: { startedAt: new Date(0) } }],
    ["beside bytes", { at: new Date(0), input: new Uint8Array([1]) }],
  ])("round-trips %s", (_label, value) => {
    expect(storageRoundTrip(value)).toEqual(value);
  });

  test("round-trips an INVALID date rather than throwing while encoding", () => {
    // `toISOString()` throws on one, and a codec that throws mid-reply turns a bad
    // timestamp in one row into a 500 for the whole call.
    const back = storageRoundTrip({ at: new Date(Number.NaN) }) as { at: Date };
    expect(back.at).toBeInstanceOf(Date);
    expect(Number.isNaN(back.at.getTime())).toBe(true);
  });

  test("leaves an ordinary ISO string a string", () => {
    // A tenant's own timestamp field is not ours to promote.
    const back = storageRoundTrip({ when: "2026-08-28T03:39:33.132Z" }) as { when: unknown };
    expect(back.when).toBe("2026-08-28T03:39:33.132Z");
  });

  test.each([
    ["a wrong __type", '{"x":{"__type":"DateTime","iso":"1970-01-01T00:00:00.000Z"}}'],
    ["no iso field", '{"x":{"__type":"Date"}}'],
    ["a non-string iso", '{"x":{"__type":"Date","iso":7}}'],
  ])("leaves %s alone rather than guessing", (_label, text) => {
    const back = decodeStorageJson(text) as { x: unknown };
    expect(back.x).not.toBeInstanceOf(Date);
  });
});

describe("the queue codec is the DevKit's, and stays theirs", () => {
  /**
   * The boundary that cost a second stalled run. `workflow-platform-queue.ts`
   * encodes a queue message with this pair and the DevKit's own
   * `createQueueHandler` decodes it — so an envelope of OURS on this path is one
   * they cannot read. With the date envelope here, their parse answered
   * `requestedAt: expected date, received Invalid Date` (`new Date(anObject)`)
   * and the sweep abandoned the message exactly as the bug it was fixing did.
   */
  test("sends a Date as the ISO string toJSON produces, never an envelope", () => {
    const encoded = JSON.parse(encodeTypedJson({ requestedAt: new Date(0) })) as {
      requestedAt: unknown;
    };
    expect(encoded.requestedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  test("still encodes bytes, which is the half that IS theirs", () => {
    const encoded = JSON.parse(encodeTypedJson({ x: new Uint8Array([1, 2]) })) as {
      x: { __type: string };
    };
    expect(encoded.x.__type).toBe("Uint8Array");
  });

  test("leaves a date envelope unrevived, so nothing depends on it by accident", () => {
    const back = decodeTypedJson('{"at":{"__type":"Date","iso":"1970-01-01T00:00:00.000Z"}}') as {
      at: unknown;
    };
    expect(back.at).not.toBeInstanceOf(Date);
  });
});
