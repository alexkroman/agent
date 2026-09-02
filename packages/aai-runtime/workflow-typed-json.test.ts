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

describe("collections, which JSON.stringify loses without a word", () => {
  test("plain JSON.stringify answers {} for both, which is the bug", () => {
    // Spelled out so the reason these envelopes exist is visible rather than
    // asserted. An index map at least still carries the bytes; this carries
    // nothing, and a step whose output was a `Map` resumed with an empty object.
    expect(JSON.stringify(new Map([["a", 1]]))).toBe("{}");
    expect(JSON.stringify(new Set([1, 2]))).toBe("{}");
  });

  test("a Map comes back as a Map, with its insertion ORDER", () => {
    // Order is a `Map`'s own guarantee, so it is asserted here — on the UNIT
    // tier, where the wire is bytes. The journal-conformance case deliberately
    // makes no ordering claim, because `jsonb` normalizes and a claim there
    // would have to hold on all four arms.
    const value = new Map<string, unknown>([
      ["z", 1],
      ["a", { nested: true }],
    ]);
    const back = storageRoundTrip(value);
    expect(back).toBeInstanceOf(Map);
    expect(back).toEqual(value);
    expect([...(back as Map<string, unknown>).keys()]).toEqual(["z", "a"]);
  });

  test("a Set comes back as a Set, with its insertion order", () => {
    const back = storageRoundTrip(new Set(["b", "a", "b"]));
    expect(back).toBeInstanceOf(Set);
    expect([...(back as Set<string>)]).toEqual(["b", "a"]);
  });

  test.each([
    ["an empty Map", new Map()],
    ["an empty Set", new Set()],
  ])("%s survives, and is not confused with an empty object", (_label, value) => {
    const back = storageRoundTrip({ v: value }) as { v: unknown };
    expect(back.v).toEqual(value);
    expect(back.v).not.toEqual({});
  });

  /**
   * The case `Object.fromEntries(map)` gets wrong, and the reason the entries
   * ride as PAIRS: a `Map`'s keys are arbitrary values, and stringifying them
   * would turn a `Date` key into an ISO string and a `Uint8Array` key into
   * `"1,2"`.
   */
  test.each([
    ["a Date", new Date(1_700_000_000_000)],
    ["a Uint8Array", new Uint8Array([1, 2])],
    // `Buffer` is deliberately NOT in this list: it comes back as a plain
    // `Uint8Array` by design (see "a Buffer is carried as binary too" above),
    // so `toEqual(key)` would fail on the CONSTRUCTOR and say nothing about
    // whether the key survived. It has its own case below.
    ["a plain object", { id: 7 }],
    ["an array", [1, 2]],
    ["a nested Map", new Map([["inner", 1]])],
    ["a Set", new Set([1])],
    ["null", null],
    ["a number", 42],
  ])("carries %s as a Map KEY, not as a stringified one", (_label, key) => {
    const value = new Map<unknown, unknown>([[key, "kept"]]);
    const back = storageRoundTrip(value) as Map<unknown, unknown>;
    expect(back).toBeInstanceOf(Map);
    expect(back.size).toBe(1);
    // Indexed rather than destructured, because `noUncheckedIndexedAccess`
    // makes a nested array pattern an error on a possibly-empty array — and the
    // size assertion above is what actually rules that out.
    const [entry] = [...back];
    expect(entry?.[0]).toEqual(key);
    expect(entry?.[1]).toBe("kept");
  });

  test.each([
    ["a Map inside a Set", new Set([new Map([["a", 1]])])],
    ["a Set inside a Map", new Map([["s", new Set([1, 2])]])],
    ["a Map two deep", new Map([["outer", new Map([["inner", new Map()]])]])],
    [
      "bytes and a date in one Map",
      new Map<unknown, unknown>([[new Date(0), new Uint8Array([9])]]),
    ],
    ["a collection in an array in a record", { rows: [new Set([1]), new Map([["k", 2]])] }],
    ["a Map at the ROOT, where the holder is stringify's own wrapper", new Map([["a", 1]])],
  ])("round-trips %s", (_label, value) => {
    expect(storageRoundTrip(value)).toEqual(value);
  });

  /**
   * `withPlainViews` declines to walk INTO a collection (it is not a plain
   * object), so the pre-pass never swaps these `Buffer`s for views and
   * `Buffer.prototype.toJSON` fires on both. `binaryReplacer`'s HOLDER read is
   * what saves them — the pair array the encoder builds is a holder like any
   * other, which is the same mechanism the `Buffer`-in-an-array cases above
   * rest on, reached by a new route. The KEY half is the one no existing case
   * could have covered.
   */
  test("a Buffer inside a Map is carried as binary, as a value AND as a key", () => {
    const key = Buffer.from([7, 8]);
    const back = storageRoundTrip(
      new Map<unknown, unknown>([
        ["b", Buffer.from([1, 2, 3])],
        [key, "keyed"],
      ]),
    ) as Map<unknown, unknown>;
    expect(back.get("b")).toEqual(new Uint8Array([1, 2, 3]));
    // The key half cannot be read with `get`: a decoded byte key is a new
    // object, so nothing the test holds is `SameValueZero`-equal to it.
    const keyed = [...back][1];
    expect(keyed?.[0]).toEqual(new Uint8Array([7, 8]));
    expect(keyed?.[1]).toBe("keyed");
  });

  test("an author's own toJSON returning a Map is encoded as one", () => {
    // The ONE case where reading `value` differs from reading the holder, and
    // the direction JSON's own semantics pick: `toJSON`'s RESULT is what gets
    // serialized, so its result is what has to be tagged. Reading the holder
    // here would see the wrapper object, miss the collection entirely and write
    // `{}` — which is the opposite of the `Buffer`/`Date` checks, where only the
    // holder can say what was really there. `collectionEnvelope`'s doc argues
    // why the two directions are both right.
    const holder = { toJSON: () => new Map([["k", 1]]) };
    expect(storageRoundTrip({ h: holder })).toEqual({ h: new Map([["k", 1]]) });
  });

  test("encodes to the tagged envelopes, pairs and all", () => {
    const encoded = JSON.parse(encodeStorageJson({ m: new Map([["k", 1]]), s: new Set([2]) })) as {
      m: { __type: string; entries: unknown };
      s: { __type: string; values: unknown };
    };
    expect(encoded.m).toEqual({ __type: "Map", entries: [["k", 1]] });
    expect(encoded.s).toEqual({ __type: "Set", values: [2] });
  });

  test.each([
    ["a wrong __type", '{"x":{"__type":"WeakMap","entries":[]}}'],
    ["entries that are not an array", '{"x":{"__type":"Map","entries":"nope"}}'],
    ["no entries field at all", '{"x":{"__type":"Map"}}'],
    ["values that are not an array", '{"x":{"__type":"Set","values":7}}'],
    ["a Set tag beside a Map payload", '{"x":{"__type":"Set","entries":[]}}'],
  ])("leaves %s alone rather than guessing", (_label, text) => {
    const back = decodeStorageJson(text) as { x: unknown };
    expect(back.x).not.toBeInstanceOf(Map);
    expect(back.x).not.toBeInstanceOf(Set);
  });

  /**
   * `new Map(entries)` alone would raise `TypeError: Iterator value 1 is not an
   * entry object` out of the middle of a `JSON.parse`, naming neither the wire
   * nor the field — and a one-element entry would not raise at all, mapping the
   * key to `undefined`, which is an invented value.
   */
  test.each([
    ["a scalar entry", '{"x":{"__type":"Map","entries":[1]}}'],
    ["a one-element entry", '{"x":{"__type":"Map","entries":[["k"]]}}'],
    ["a three-element entry", '{"x":{"__type":"Map","entries":[["k",1,2]]}}'],
    ["an object entry", '{"x":{"__type":"Map","entries":[{"0":"k","1":1}]}}'],
  ])("throws on %s rather than inventing a Map", (_label, text) => {
    expect(() => decodeStorageJson(text)).toThrow(/not a \[key, value\] pair/);
  });

  test("a Set of anything decodes, because an array is already the payload", () => {
    const back = decodeStorageJson('{"x":{"__type":"Set","values":[1,"a",null]}}') as {
      x: Set<unknown>;
    };
    expect([...back.x]).toEqual([1, "a", null]);
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

  /**
   * The collection envelopes drew the SAME boundary as the date one, and this
   * pins the emission side of it: a queue payload is engine-internal — a run id
   * and a step key — so no author value reaches it, and an envelope of ours on
   * this path is one the far end cannot read. The `{}` here is the general
   * unsupported-type hole, deliberately still open on the wire that cannot
   * carry an answer to it.
   */
  test("sends a Map and a Set as {} — no envelope on this path", () => {
    expect(encodeTypedJson({ m: new Map([["k", 1]]), s: new Set([1]) })).toBe('{"m":{},"s":{}}');
  });

  test.each([
    ["a Map envelope", '{"v":{"__type":"Map","entries":[["k",1]]}}'],
    ["a Set envelope", '{"v":{"__type":"Set","values":[1]}}'],
  ])("leaves %s unrevived, so nothing depends on it by accident", (_label, text) => {
    const back = decodeTypedJson(text) as { v: unknown };
    expect(back.v).not.toBeInstanceOf(Map);
    expect(back.v).not.toBeInstanceOf(Set);
  });
});

/**
 * What only a HOSTILE or corrupt wire can produce.
 *
 * These cannot be reached through a round trip — that is the point of the escape
 * scheme — so they are named cases against raw JSON text, which is what a peer
 * actually sends.
 */
describe("a forged or corrupt envelope on the wire", () => {
  /**
   * The reported bug, pinned in the exact shape it was reported in.
   *
   * A run's `input` arrives at `POST /workflows/runs`, which is public HTTP, so
   * an author's plain object becoming a `Uint8Array` is type confusion across a
   * trust boundary — a step that declared `z.object({ __type: z.string() })`
   * received bytes.
   */
  test.each([
    ["at the top level", { __type: "Uint8Array", data: "aGVsbG8=" }],
    ["nested in a record", { run: { __type: "Uint8Array", data: "aGVsbG8=" } }],
    ["at depth in an array", { chunks: [{ __type: "Uint8Array", data: "AAA=" }] }],
    ["a date envelope", { __type: "Date", iso: "2020-01-01T00:00:00.000Z" }],
    ["already-escaped, written by the author", { __type: "x", ___type: "y", ____type: "z" }],
    // The collection envelopes, which are the reason the escape's totality is
    // a property of the KEY family rather than of the tag values it has heard
    // of: these two needed no change to `workflow-typed-json-escape.ts`.
    ["a Map envelope", { __type: "Map", entries: [["k", 1]] }],
    ["a Set envelope", { __type: "Set", values: [1, 2] }],
    ["a Map envelope at depth", { runs: [{ out: { __type: "Map", entries: [] } }] }],
    // A forged Map envelope whose entries would THROW if it were ever revived,
    // so a lapse in the escape fails loudly here rather than mangling a value.
    ["a Map envelope with unrevivable entries", { __type: "Map", entries: [1, 2] }],
  ])("an author's own envelope-shaped object survives as DATA %s", (_label, value) => {
    expect(roundTrip(value)).toEqual(value);
    expect(storageRoundTrip(value)).toEqual(value);
  });

  /**
   * `Buffer.from(s, "base64")` DROPS characters outside the alphabet and returns
   * whatever the survivors decode to, so the codec used to answer ten arbitrary
   * bytes for `"not base64 at all!!"` with nothing raised. That is the same
   * silent-garbage failure the module exists to prevent, one layer in.
   */
  test.each([
    ["not base64 at all", '{"x":{"__type":"Uint8Array","data":"not base64 at all!!"}}'],
    ["an unpadded final chunk", '{"x":{"__type":"Uint8Array","data":"aGVsbG8"}}'],
    ["non-zero trailing bits", '{"x":{"__type":"Uint8Array","data":"AAB="}}'],
    ["the url-safe alphabet, which is not ours", '{"x":{"__type":"Uint8Array","data":"-_A="}}'],
  ])("throws on %s rather than inventing bytes", (_label, text) => {
    expect(() => decodeTypedJson(text)).toThrow(/malformed base64/);
  });

  test("still accepts the canonical base64 it writes itself", () => {
    const back = decodeTypedJson('{"x":{"__type":"Uint8Array","data":"aGVsbG8="}}') as {
      x: Uint8Array;
    };
    expect(Buffer.from(back.x).toString()).toBe("hello");
  });

  /**
   * `iso: null` is the ENCODER's own spelling of an invalid date, so it revives as
   * one. A non-null string that will not parse is corruption, and reviving it
   * would hand the guest the `NaN` that stalled every durable run.
   */
  test("throws on a date envelope whose iso will not parse", () => {
    expect(() => decodeStorageJson('{"x":{"__type":"Date","iso":"garbage"}}')).toThrow(
      /unparsable iso/,
    );
  });

  /**
   * `JSON.parse` makes `__proto__` a real own property, and `out[key] = …` on an
   * object literal invokes the prototype SETTER — so a rebuild by assignment
   * drops the key AND repoints the copy's prototype at author-controlled data.
   * The escape rebuild is the only place in this codec that rebuilds a parsed
   * object, and it uses `Object.fromEntries`, which defines instead of assigns.
   */
  test("carries __proto__ as ordinary data, without polluting a prototype", () => {
    // Built with `JSON.parse` rather than as a literal, because `__proto__:` in an
    // object LITERAL is the prototype-setter syntax and creates no own property at
    // all — the first draft of this test asserted against an input that had
    // already lost the key. A request body is parsed, which is the real shape.
    // The reserved key is what forces the escape rebuild; `__proto__` rides along.
    const value = JSON.parse(
      '{"__type":"tenant","__proto__":{"polluted":true},"keep":1}',
    ) as Record<string, unknown>;
    const back = roundTrip(value) as Record<string, unknown>;
    expect(Object.keys(back)).toEqual(["__type", "__proto__", "keep"]);
    // The OWN property, read without going through the deprecated accessor —
    // which is also the only way to see it if a rebuild had repointed the
    // prototype, since the accessor would then answer the polluted object.
    expect(Object.getOwnPropertyDescriptor(back, "__proto__")?.value).toEqual({
      polluted: true,
    });
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  /**
   * The compatibility direction, and the reason the deployment order is
   * decoder-first: escaping only ever adds a key spelling no previous encoder
   * produced, so everything already on the wire decodes exactly as it did.
   */
  test("a BARE envelope from the DevKit's own transport still decodes to bytes", () => {
    const back = decodeTypedJson('{"input":{"__type":"Uint8Array","data":"AQI="}}') as {
      input: unknown;
    };
    expect(back.input).toEqual(new Uint8Array([1, 2]));
  });
});
