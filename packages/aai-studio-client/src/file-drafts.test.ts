// Copyright 2026 the AAI authors. MIT license.
// The buffer rules are the one place user work can be lost, so they are a pure
// function: what happens to unsaved text when the agent edits the same file is
// decided here, not by a component React is free to unmount.

import { describe, expect, test } from "vitest";
import { anyDirty, bufferFor, type FileBuffers, syncBuffers } from "./file-drafts.ts";

const clean = (text: string) => ({
  draft: text,
  dirty: false,
  conflict: false,
  lastServer: text,
});
const edited = (text: string, lastServer: string) => ({
  draft: text,
  dirty: true,
  conflict: false,
  lastServer,
});

describe("syncBuffers", () => {
  test("adopts a server update while the buffer is clean", () => {
    const next = syncBuffers({ "agent.ts": clean("v1") }, { "agent.ts": "v2" });
    expect(next["agent.ts"]).toEqual({
      draft: "v2",
      dirty: false,
      conflict: false,
      lastServer: "v2",
    });
  });

  test("keeps unsaved edits when the server changes, and flags the conflict", () => {
    const next = syncBuffers({ "agent.ts": edited("my edit", "v1") }, { "agent.ts": "agent edit" });
    // The user's work survives; the overwrite risk is surfaced, not silent.
    expect(next["agent.ts"]).toEqual({
      draft: "my edit",
      dirty: true,
      conflict: true,
      lastServer: "agent edit",
    });
  });

  test("a just-saved buffer is not reverted by a workspace refetch still in flight", () => {
    // markSaved leaves `lastServer` on the pre-save content, so this is the
    // render between the write and the refetch landing: nothing has changed on
    // the server yet as far as this buffer knows, and the draft must stay put.
    const saved: FileBuffers = {
      "agent.ts": { draft: "my edit", dirty: false, conflict: false, lastServer: "agent edit" },
    };
    expect(syncBuffers(saved, { "agent.ts": "agent edit" })).toBe(saved);
    // Once the refetch lands the saved content, adopting it is a no-op.
    const settled = syncBuffers(saved, { "agent.ts": "my edit" });
    expect(settled["agent.ts"]?.draft).toBe("my edit");
    expect(settled["agent.ts"]?.conflict).toBe(false);
  });

  test("a clean buffer never reports a conflict, however often the server moves", () => {
    const once = syncBuffers({ "agent.ts": clean("v1") }, { "agent.ts": "v2" });
    const twice = syncBuffers(once, { "agent.ts": "v3" });
    expect(twice["agent.ts"]).toEqual({
      draft: "v3",
      dirty: false,
      conflict: false,
      lastServer: "v3",
    });
  });

  test("a file deleted from the workspace reads as empty rather than throwing", () => {
    const next = syncBuffers({ "gone.ts": clean("v1") }, {});
    expect(next["gone.ts"]?.draft).toBe("");
  });

  test("returns the same object when nothing moved", () => {
    // The render-time sync calls this on EVERY render; a fresh object each
    // time would set state during render forever.
    const buffers = { "agent.ts": clean("v1"), "tools/a.ts": edited("draft", "v1") };
    expect(syncBuffers(buffers, { "agent.ts": "v1", "tools/a.ts": "v1" })).toBe(buffers);
  });

  test("only the file whose server content moved is rebuilt", () => {
    const untouched = clean("v1");
    const next = syncBuffers(
      { "agent.ts": untouched, "b.ts": clean("b1") },
      { "agent.ts": "v1", "b.ts": "b2" },
    );
    expect(next["agent.ts"]).toBe(untouched);
    expect(next["b.ts"]?.draft).toBe("b2");
  });
});

describe("bufferFor", () => {
  test("defaults an unopened file to the server's content", () => {
    expect(bufferFor({}, "agent.ts", { "agent.ts": "hello" })).toEqual({
      draft: "hello",
      dirty: false,
      conflict: false,
      lastServer: "hello",
    });
  });

  test("returns the held buffer once there is one", () => {
    const held = edited("mine", "hello");
    expect(bufferFor({ "agent.ts": held }, "agent.ts", { "agent.ts": "hello" })).toBe(held);
  });

  test("no open file is an empty, clean buffer", () => {
    expect(bufferFor({}, null, { "agent.ts": "hello" }).draft).toBe("");
  });
});

describe("anyDirty", () => {
  test("is what the beforeunload guard asks", () => {
    expect(anyDirty({})).toBe(false);
    expect(anyDirty({ "a.ts": clean("v1") })).toBe(false);
    expect(anyDirty({ "a.ts": clean("v1"), "b.ts": edited("x", "v1") })).toBe(true);
  });
});
