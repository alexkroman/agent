// Copyright 2026 the AAI authors. MIT license.
// The shipped-prompt loader's seams. Every claim here is about the ONE failure
// this module exists to remove: a case that asked for the studio's real prompt
// and got something else without saying so.

import { describe, expect, test } from "vitest";
import {
  _resetShippedStudioPromptCache,
  shippedStudioPrompt,
  studioStarter,
  studioStarters,
} from "./_eval-prompt.ts";

/**
 * A directory with no committed copy in it — this source directory.
 *
 * The not-on-disk branches are reached by pointing the readers HERE rather than
 * by writing a temp file (a unit test may read the filesystem, never write it).
 */
const NO_COPIES_HERE = new URL("..", import.meta.url);

describe("shippedStudioPrompt", () => {
  test("loads the committed copy", () => {
    const prompt = shippedStudioPrompt();
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
    const prompt = shippedStudioPrompt();
    expect(prompt).not.toMatch(/GENERATED FILE/);
    expect(prompt.trimStart()).toBe(prompt.trimStart());
    expect(prompt.startsWith("<!--")).toBe(false);
  });

  test("says what to run when the copy is missing, and does not fall back", () => {
    _resetShippedStudioPromptCache();
    expect(() => shippedStudioPrompt(NO_COPIES_HERE)).toThrow(/sync-studio-prompt\.mjs/);
    // The half that matters more than the message: it THREW. A fallback to the
    // harness prompt here would let a case report green while measuring a
    // string the studio never sends.
    expect(() => shippedStudioPrompt(NO_COPIES_HERE)).toThrow(/SHIPPED/);
  });

  test("a lookaside read is not memoized as the real prompt", () => {
    // The failure the `memoize` flag exists against: a spec that pointed at an
    // empty directory must not be able to poison the cache the harness reads.
    _resetShippedStudioPromptCache();
    expect(() => shippedStudioPrompt(NO_COPIES_HERE)).toThrow();
    expect(shippedStudioPrompt().length).toBeGreaterThan(50_000);
  });

  test("memoizes — a case may ask repeatedly and these files are ~150KB", () => {
    _resetShippedStudioPromptCache();
    expect(shippedStudioPrompt()).toBe(shippedStudioPrompt());
  });
});

describe("studioStarters", () => {
  test("carries the catalog, with prompts", () => {
    const starters = studioStarters();
    expect(starters.length).toBeGreaterThan(0);
    for (const starter of starters) {
      expect(starter.label).not.toBe("");
      expect(starter.prompt).not.toBe("");
    }
  });

  test("reports a catalog it cannot find rather than an empty one", () => {
    expect(() => studioStarters(new URL("./nope.json", NO_COPIES_HERE))).toThrow();
  });
});

describe("studioStarters' shape check", () => {
  test("rejects the banner string, which is the one that could pass unnoticed", () => {
    // `_generated` is a STRING with a length; a loose guard would hand a case
    // a "catalog" of characters. package.json has no `starters` key at all.
    expect(() => studioStarters(new URL("./package.json", NO_COPIES_HERE))).toThrow(/no starters/);
  });
});

describe("studioStarter", () => {
  test("finds a starter by the studio's own label", () => {
    const [first] = studioStarters();
    expect.assert(first);
    expect(studioStarter(first.label)).toEqual(first);
  });

  test("a label the studio no longer offers FAILS, and lists what it does", () => {
    // The point of syncing the catalog rather than inlining a prompt: a starter
    // renamed upstream breaks the case that graded it instead of leaving it
    // measuring a string frozen here.
    expect(() => studioStarter("A starter nobody ships")).toThrow(/The studio offers: /);
  });
});
