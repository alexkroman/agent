// Copyright 2026 the AAI authors. MIT license.
/**
 * Which builtins an agent gets when it names none.
 *
 * The list is short and the rule behind it is a policy decision, so it is
 * stated here rather than inferred from the one constant: a builtin is
 * something an author asks for, and `listen_for` is the single exception —
 * it changes only what the agent HEARS, and is worth most exactly where
 * nobody thought to switch it on.
 */

import { describe, expect, it } from "vitest";

import { defaultBuiltinTools } from "./builtin-tools.ts";
import { DEFAULT_BUILTIN_TOOLS } from "./constants.ts";

describe("defaultBuiltinTools", () => {
  it("gives a PIPELINE agent the full default list", () => {
    // The default pipeline: no `s2s`, not text. This is the only mode with a
    // recognizer the runtime can steer.
    expect(defaultBuiltinTools({})).toEqual([...DEFAULT_BUILTIN_TOOLS]);
    expect(defaultBuiltinTools({})).toContain("listen_for");
  });

  it("withholds listen_for from a TEXT agent", () => {
    // No audio at all, so the tool could only ever answer "this session's
    // recognizer cannot be steered" — at the cost of its schema and guidance
    // on every request the agent makes.
    expect(defaultBuiltinTools({ text: true })).not.toContain("listen_for");
  });

  it("withholds it from an S2S agent", () => {
    // Recognition runs service-side behind a socket that exposes no control
    // over it, which is why `ctx.steerRecognizer` answers false there.
    expect(defaultBuiltinTools({ s2s: { kind: "assemblyai", options: {} } })).not.toContain(
      "listen_for",
    );
  });

  it("is not fooled by a FALSE text flag", () => {
    // `text: false` is a pipeline agent that wrote the field out; only `true`
    // selects text mode, and `agent.text !== true` is the test for that
    // reason rather than a truthiness check.
    expect(defaultBuiltinTools({ text: false })).toContain("listen_for");
  });

  it("filters rather than empties, so a second default would survive the scoping", () => {
    // The shape to preserve: the mode rule is about `listen_for`, not about
    // "defaults are off in text mode". A future default that works anywhere
    // must still reach a text agent.
    const textDefaults = defaultBuiltinTools({ text: true });
    const others = DEFAULT_BUILTIN_TOOLS.filter((n) => n !== "listen_for");
    expect(textDefaults).toEqual([...others]);
  });
});
