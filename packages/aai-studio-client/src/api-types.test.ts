// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { isChatMessages, isProjectData, isProjectNames } from "./api-types.ts";

// These three are what a pushed SSE frame is narrowed with (see `api-events.ts`
// and the dispatches in `api.ts`). They replaced `JSON.parse(frame.data) as T`,
// so what is worth pinning is the half a cast could not do: a payload that is
// not the shape this build expects is REFUSED, and the fields the panes read
// are the fields that decide.

describe("isProjectData", () => {
  test("accepts the server's payload, extra fields included", () => {
    // `projectPayload` (aai-studio-server/studio-sse.ts) sends `sourceHash`,
    // which `ProjectData` does not declare and no pane reads — so an
    // undeclared field must not make a legitimate push unrecognisable.
    expect(
      isProjectData({
        files: { "agent.ts": "export default {}" },
        sourceHash: "abc",
        kind: "workflow",
        unpublished: false,
        previewStale: true,
        githubStale: false,
        deployedSlug: "my-agent",
      }),
    ).toBe(true);
    // `files` alone is required; every other field is optional.
    expect(isProjectData({ files: {} })).toBe(true);
  });

  test("refuses anything that is not a project payload", () => {
    // `undefined` is what the SDK's reader yields for a frame whose `data:`
    // line was not JSON — the case the old `JSON.parse` threw on, tearing
    // down a healthy stream.
    expect(isProjectData(undefined)).toBe(false);
    expect(isProjectData(null)).toBe(false);
    expect(isProjectData([])).toBe(false);
    expect(isProjectData({})).toBe(false);
    // The one the cast was worst at: `files` absent or not a file map put
    // `undefined` where every consumer indexes, and blanked the Code pane.
    expect(isProjectData({ files: "nope" })).toBe(false);
    expect(isProjectData({ files: { "agent.ts": 42 } })).toBe(false);
  });

  test("a declared field of the wrong type is refused, not coerced", () => {
    expect(isProjectData({ files: {}, kind: "voice" })).toBe(false);
    expect(isProjectData({ files: {}, previewSlug: 7 })).toBe(false);
    expect(isProjectData({ files: {}, previewStale: "yes" })).toBe(false);
    expect(isProjectData({ files: {}, githubCommit: null })).toBe(false);
  });
});

describe("isChatMessages", () => {
  test("accepts a message list and checks the envelope of every entry", () => {
    expect(isChatMessages([])).toBe(true);
    expect(
      isChatMessages([
        { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
        { id: "m2", role: "assistant", parts: [] },
      ]),
    ).toBe(true);
  });

  test("refuses a list whose entries are missing what a reader reads", () => {
    expect(isChatMessages(undefined)).toBe(false);
    expect(isChatMessages({ messages: [] })).toBe(false);
    expect(isChatMessages([null])).toBe(false);
    expect(isChatMessages(["m1"])).toBe(false);
    expect(isChatMessages([{ role: "user", parts: [] }])).toBe(false);
    expect(isChatMessages([{ id: "m1", role: "tool", parts: [] }])).toBe(false);
    // `parts` is mapped by the transcript, so a non-array is a render throw.
    expect(isChatMessages([{ id: "m1", role: "user" }])).toBe(false);
    expect(isChatMessages([{ id: "m1", role: "user", parts: "hi" }])).toBe(false);
  });

  test("says nothing about a PART's shape, deliberately", () => {
    // The part union is the AI SDK's to version, and both readers here switch
    // on `part.type` and ignore what they do not recognise — a validator here
    // would be a second, staler copy of that rule. So an unknown part kind
    // travels; it is dropped where it is rendered, not where it is received.
    expect(isChatMessages([{ id: "m1", role: "user", parts: [{ type: "tool-from-2027" }] }])).toBe(
      true,
    );
  });
});

describe("isProjectNames", () => {
  test("accepts a list of names and refuses anything else", () => {
    expect(isProjectNames([])).toBe(true);
    expect(isProjectNames(["a", "b"])).toBe(true);
    // Fully checkable, unlike the two shapes above — so it is fully checked.
    expect(isProjectNames([1, 2])).toBe(false);
    expect(isProjectNames(["a", null])).toBe(false);
    expect(isProjectNames(undefined)).toBe(false);
    expect(isProjectNames("a")).toBe(false);
  });
});
