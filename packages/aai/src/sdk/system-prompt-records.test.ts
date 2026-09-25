// Copyright 2026 the AAI authors. MIT license.
// The default prompt's rules for working with records a tool returned: finding
// the caller's account, resolving what they point at, and writing changes back.
// Split from system-prompt.test.ts, which sits at the test-file line cap.

import { describe, expect, test } from "vitest";
import { makeConfig } from "../host/_test-utils.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

describe("buildSystemPrompt — records and lookups", () => {
  // A name heard SPOKEN ("Sophia") was sent eight times in one call while the
  // account was spelled the other common way; letter confusions never turn one
  // spelling of a name into the other, so the ladder never reached it.
  test("the ladder tries a spoken name's other common spellings after the exact one", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    const ladder = result.slice(result.indexOf("MIS-HEARING until proven"));
    const onlyAfter = ladder.indexOf("Only after the exact spelling has failed");
    const spoken = ladder.indexOf("its other common spellings");
    expect(spoken).toBeGreaterThan(onlyAfter);
    expect(ladder).toContain("first name and surname alike");
  });

  // The agent told the caller a value "isn't on file" because the record they
  // named lacked it — while another result it had already fetched held it —
  // and elsewhere wrote an address built from two records' fields.
  test("a value on file counts if any fetched result holds it, taken from one record", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("present if ANY result");
    expect(result).toContain("never combine fields from two");
  });

  // "The same colour as my other one" was answered by asking the caller to
  // recall it, or with the colour of the item being replaced — while the
  // referenced record was fetchable (once, already fetched).
  test("a choice defined by another record takes its value from that record", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("takes its value from\n  THAT record");
    expect(result).toContain("never take it from the\n  thing being replaced");
  });

  // Two agreed changes to one record, made lock-first: the agent then refused
  // the second as if the one-time limit on the first covered every kind.
  test("changes to one record go editable-first, and a once-limit binds one kind only", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("the one that locks it last");
    expect(result).toContain("does not block a different kind");
  });
});
