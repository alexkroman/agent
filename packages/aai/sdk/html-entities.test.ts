// Copyright 2026 the AAI authors. MIT license.
/**
 * The decoder, and mostly the one property the two template copies had to argue
 * for in a comment: an entity the decoding PRODUCED is not decoded again.
 *
 * That is the whole reason this is one function rather than two, so the tests
 * that matter are the double-encoded ones — they are what a chained-`replace`
 * version gets wrong the moment somebody reorders the calls, and what no
 * hand-written fixture of ordinary prose would ever catch.
 */
import { describe, expect, test } from "vitest";
import { decodeHtmlEntities } from "./html-entities.ts";

describe("decodeHtmlEntities", () => {
  test.each([
    ["", ""],
    ["nothing to do", "nothing to do"],
    ["Fish &amp; Chips", "Fish & Chips"],
    ["&lt;b&gt;bold&lt;/b&gt;", "<b>bold</b>"],
    ["she said &quot;hello&quot;", 'she said "hello"'],
    // Both widths of the numeric apostrophe, and the XML-only named form.
    ["it&#39;s", "it's"],
    ["it&#039;s", "it's"],
    ["it&apos;s", "it's"],
    // An ordinary space, not U+00A0 — a word count must not see a character
    // that reads as a space and is not one.
    ["a&nbsp;b", "a b"],
    // Every entity at once, so a table entry that goes missing shows up here.
    ["&lt;&gt;&quot;&apos;&nbsp;&amp;", "<>\"' &"],
    ["a query: ?x=1&amp;y=2&amp;z=3", "a query: ?x=1&y=2&z=3"],
  ])("decodes %j", (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  test.each([
    // THE case. A page writing ABOUT markup double-encodes it, and a decoder
    // that ran `&amp;` first would answer `<b>` — a tag the document never
    // contained, in text about to be handed to a model.
    ["&amp;lt;b&amp;gt;", "&lt;b&gt;"],
    ["&amp;amp;", "&amp;"],
    ["&amp;nbsp;", "&nbsp;"],
    // Triple encoding peels exactly one layer, for the same reason.
    ["&amp;amp;lt;", "&amp;lt;"],
  ])("peels exactly one layer off %j", (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  test.each([
    // Not in the table: left alone rather than guessed at or dropped.
    ["&hellip;", "&hellip;"],
    ["&copy; 2026", "&copy; 2026"],
    // Malformed: a bare ampersand, an unterminated entity, an empty one.
    ["a & b", "a & b"],
    ["&amp", "&amp"],
    ["&lt", "&lt"],
    ["&;", "&;"],
    // A numeric width the table does not carry stays as it is — the point of
    // `&#0?39;` is those two widths, not a numeric-entity parser.
    ["&#0039;", "&#0039;"],
    // Case-sensitive, which is what HTML says: `&AMP;` is not `&amp;`.
    ["&AMP;", "&AMP;"],
  ])("leaves %j alone", (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  test("replaces every occurrence, not just the first", () => {
    expect(decodeHtmlEntities("&amp;&amp;&amp;")).toBe("&&&");
  });

  test("is a single pass, so the answer cannot depend on the table's order", () => {
    // The property, stated directly: decoding is defined over the ORIGINAL
    // text, so no permutation of the table could produce a different answer.
    // A chained-`replace` implementation cannot satisfy this, which is why the
    // two template copies each carried an ordering comment.
    const once = decodeHtmlEntities("&amp;lt;");
    expect(once).toBe("&lt;");
    expect(decodeHtmlEntities(once)).toBe("<");
  });
});
