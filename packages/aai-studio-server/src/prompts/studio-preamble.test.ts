// Copyright 2026 the AAI authors. MIT license.
// The studio preamble for one project kind (studio-preamble.ts): the shared
// arc with the kind's fragments and the SDK guidance composed in. The prompt
// it heads — preamble plus scaffold reference — is studio-prompt.test.ts.

import { describe, expect, test } from "vitest";
import { PROJECT_KINDS } from "../studio-project-kind.ts";
import { sdkSpecifiers } from "../studio-sdk-exports.ts";
import { studioPreamble } from "./studio-preamble.ts";
import { PREAMBLE_MODES } from "./studio-preamble-mode.ts";
import { STUDIO_SDK_GUIDANCE } from "./studio-preamble-sdk.ts";

describe("studioPreamble", () => {
  test.each(PROJECT_KINDS)("the %s preamble carries its own five fragments", (kind) => {
    const preamble = studioPreamble(kind);
    for (const fragment of Object.values(PREAMBLE_MODES[kind])) {
      expect(preamble).toContain(fragment);
    }
  });

  test("never carries the other kind's fragments", () => {
    expect(studioPreamble("agent")).not.toContain(PREAMBLE_MODES.workflow.productShape);
    expect(studioPreamble("workflow")).not.toContain(PREAMBLE_MODES.agent.productShape);
  });

  test.each(PROJECT_KINDS)("the %s preamble embeds the shared SDK guidance", (kind) => {
    expect(studioPreamble(kind)).toContain(STUDIO_SDK_GUIDANCE);
  });

  test("lists the SDK's importable subpaths, read from its exports map", () => {
    const specs = sdkSpecifiers();
    expect(specs.length).toBeGreaterThan(1);
    expect(studioPreamble("agent")).toContain(specs.join(", "));
  });

  test("is pure: the same kind composes the same text", () => {
    expect(studioPreamble("workflow")).toBe(studioPreamble("workflow"));
  });
});
