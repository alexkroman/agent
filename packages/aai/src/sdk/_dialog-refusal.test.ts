// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { dialogRefusalMessage, dialogRefusalPattern } from "./_dialog-refusal.ts";
import { toolFailure } from "./utils.ts";

describe("dialogRefusalMessage", () => {
  test("names the state in quotes and ends with what has to happen first", () => {
    expect(dialogRefusalMessage("identifying", "Verify the caller first.")).toBe(
      'Not available yet: this conversation is at "identifying". Verify the caller first.',
    );
  });

  test("what it writes is what the pattern reads — the whole reason both live here", () => {
    // The gate builds the sentence and a spec matches it; a rewording that
    // reached one and not the other is exactly the drift this module exists to
    // make impossible, so the two are checked against each other rather than
    // each against a literal.
    const written = dialogRefusalMessage("onCall.inbox", "Read the email first.");
    expect(written).toMatch(dialogRefusalPattern());
    expect(written).toMatch(dialogRefusalPattern("onCall.inbox"));
    expect(written).not.toMatch(dialogRefusalPattern("onCall.reviewing"));
  });
});

describe("dialogRefusalPattern", () => {
  test("matches the gate's own sentence, and pins the state when given one", () => {
    const refused = 'Not available yet: this conversation is at "identifying". Verify first.';
    expect(refused).toMatch(dialogRefusalPattern());
    expect(refused).toMatch(dialogRefusalPattern("identifying"));
    expect(refused).not.toMatch(dialogRefusalPattern("transferred"));
  });

  test("a dotted state is matched literally — `.` is not 'any character' here", () => {
    expect('Not available yet: this conversation is at "onCall.inbox". Read it.').toMatch(
      dialogRefusalPattern("onCall.inbox"),
    );
    expect('Not available yet: this conversation is at "onCallXinbox". Read it.').not.toMatch(
      dialogRefusalPattern("onCall.inbox"),
    );
  });

  test("a state is matched whole, not as a prefix of a longer one", () => {
    const refused = 'Not available yet: this conversation is at "working.monitoring". Wait.';
    expect(refused).toMatch(dialogRefusalPattern("working.monitoring"));
    expect(refused).not.toMatch(dialogRefusalPattern("working"));
  });

  test("reads the sentence through JSON escaping, which is how an eval sees a tool result", () => {
    // A tool result crosses the event stream as a serialized string, so the
    // state's quotes arrive as `\"standby\"`. Two template evals had each
    // written a character class to absorb that; the pattern does it once.
    const serialized = JSON.stringify(
      toolFailure(dialogRefusalMessage("standby", "Log a call first.")),
    );
    expect(serialized).toContain('\\"standby\\"');
    expect(serialized).toMatch(dialogRefusalPattern("standby"));
    expect(serialized).toMatch(dialogRefusalPattern());
    expect(serialized).not.toMatch(dialogRefusalPattern("working"));
  });

  test("a sentence that is not the gate's does not match, however it mentions a state", () => {
    expect('The order is at "identifying" and cannot be changed.').not.toMatch(
      dialogRefusalPattern("identifying"),
    );
    expect("Order not found.").not.toMatch(dialogRefusalPattern());
  });
});
