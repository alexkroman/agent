// Copyright 2026 the AAI authors. MIT license.
// The shipped-prompt loader's seams. Every claim here is about the ONE failure
// this module exists to remove: a case that asked for the studio's real prompt
// and got something else without saying so.

import { describe, expect, test } from "vitest";
import {
  _resetShippedStudioPromptCache,
  STUDIO_PROMPT_KINDS,
  shippedStudioPrompt,
  studioPromptKind,
  studioStarter,
  studioStarters,
} from "./_eval-prompt.ts";

/**
 * A directory with no committed copy in it — this source directory.
 *
 * The not-on-disk branches are reached by pointing the readers HERE rather than
 * by casting an invalid kind past the type (`"nope" as never`, which
 * `check:hatches` counts) or by writing a temp file (a unit test may read the
 * filesystem, never write it).
 */
const NO_COPIES_HERE = new URL("..", import.meta.url);

describe("shippedStudioPrompt", () => {
  test.each(STUDIO_PROMPT_KINDS)("loads the committed copy for %s", (kind) => {
    const prompt = shippedStudioPrompt(kind);
    // It is the studio's prompt and not a placeholder: the preamble's own
    // subject, and the authoring guide it inlines. Cheap, but it is the check
    // that fails if `sync-studio-prompt.mjs` ever writes the compact FALLBACK
    // guide instead of the scaffold one — which is a prompt the studio does not
    // send, and would otherwise be indistinguishable from the real thing here.
    expect(prompt.length).toBeGreaterThan(50_000);
    expect(prompt).toMatch(/agent\(/);
  });

  test("strips the generated banner, which is not part of the prompt", () => {
    // A model handed the banner would read "GENERATED FILE — do not edit" as an
    // instruction about the workspace it is working in.
    const prompt = shippedStudioPrompt("agent");
    expect(prompt).not.toMatch(/GENERATED FILE/);
    expect(prompt.trimStart()).toBe(prompt.trimStart());
    expect(prompt.startsWith("<!--")).toBe(false);
  });

  test("the two kinds really are different prompts", () => {
    // `studioPreamble(kind)` swaps its mode-dependent fragments. If these came
    // back equal, the sync script would be writing one prompt twice and the
    // workflow cases would be grading the voice-agent prompt.
    expect(shippedStudioPrompt("agent")).not.toBe(shippedStudioPrompt("workflow"));
  });

  test("says what to run when the copy is missing, and does not fall back", () => {
    _resetShippedStudioPromptCache();
    expect(() => shippedStudioPrompt("agent", NO_COPIES_HERE)).toThrow(/sync-studio-prompt\.mjs/);
    // The half that matters more than the message: it THREW. A fallback to the
    // harness prompt here would let a case report green while measuring a
    // string the studio never sends.
    expect(() => shippedStudioPrompt("agent", NO_COPIES_HERE)).toThrow(/SHIPPED/);
  });

  test("a lookaside read is not memoized as the real prompt", () => {
    // The failure the `memoize` flag exists against: a spec that pointed at an
    // empty directory must not be able to poison the cache the harness reads.
    _resetShippedStudioPromptCache();
    expect(() => shippedStudioPrompt("agent", NO_COPIES_HERE)).toThrow();
    expect(shippedStudioPrompt("agent").length).toBeGreaterThan(50_000);
  });

  test("memoizes — a case may ask repeatedly and these files are ~150KB", () => {
    _resetShippedStudioPromptCache();
    expect(shippedStudioPrompt("agent")).toBe(shippedStudioPrompt("agent"));
  });
});

describe("studioStarters", () => {
  test.each(STUDIO_PROMPT_KINDS)("carries the %s catalog, with prompts", (kind) => {
    const starters = studioStarters(kind);
    expect(starters.length).toBeGreaterThan(0);
    for (const starter of starters) {
      expect(starter.label).not.toBe("");
      expect(starter.prompt).not.toBe("");
    }
  });

  test("reports a catalog it cannot find rather than an empty one", () => {
    expect(() => studioStarters("agent", new URL("./nope.json", NO_COPIES_HERE))).toThrow();
  });
});

describe("studioPromptKind", () => {
  test.each(STUDIO_PROMPT_KINDS)("accepts %s", (kind) => {
    expect(studioPromptKind(kind)).toBe(kind);
  });

  test("rejects the banner key, which is the one that could pass unnoticed", () => {
    // `_generated` is a real KEY in starters.json and its value is a string, so
    // a kind that was never validated would index it and hand a case a
    // "catalog" of characters — one starter per letter, each with no prompt.
    expect(() => studioPromptKind("_generated")).toThrow(/not a studio project kind/);
  });

  test("names the kinds there are, so a typo is self-correcting", () => {
    expect(() => studioPromptKind("Agent")).toThrow(/agent, workflow/);
  });
});

describe("studioStarter", () => {
  test("finds a starter by the studio's own label", () => {
    const [first] = studioStarters("agent");
    expect(first).toBeDefined();
    if (!first) return;
    expect(studioStarter("agent", first.label)).toEqual(first);
  });

  test("a label the studio no longer offers FAILS, and lists what it does", () => {
    // The point of syncing the catalog rather than inlining a prompt: a starter
    // renamed upstream breaks the case that graded it instead of leaving it
    // measuring a string frozen here.
    expect(() => studioStarter("agent", "A starter nobody ships")).toThrow(/The studio offers: /);
  });
});
