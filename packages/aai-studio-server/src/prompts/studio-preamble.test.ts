// Copyright 2026 the AAI authors. MIT license.
// The studio preamble (studio-preamble.ts): the shared arc with the SDK
// guidance composed in. The prompt it heads — preamble plus scaffold
// reference — is studio-prompt.test.ts.

import { describe, expect, test } from "vitest";
import { sdkSpecifiers } from "../studio-sdk-exports.ts";
import { studioPreamble } from "./studio-preamble.ts";
import { STUDIO_SDK_GUIDANCE } from "./studio-preamble-sdk.ts";

describe("studioPreamble", () => {
  test("builds a voice agent by default", () => {
    const preamble = studioPreamble();
    expect(preamble).toContain("Build a voice agent");
    expect(preamble).toContain("Default to a VOICE agent");
    expect(preamble).toContain("Replies are spoken aloud");
    // The retired Voice agent / Workflow switch is not mentioned.
    expect(preamble).not.toContain("The user chose");
    expect(preamble).not.toContain("Nothing here is spoken");
  });

  test("embeds the shared SDK guidance", () => {
    expect(studioPreamble()).toContain(STUDIO_SDK_GUIDANCE);
  });

  test("lists the SDK's importable subpaths, read from its exports map", () => {
    const specs = sdkSpecifiers();
    expect(specs.length).toBeGreaterThan(1);
    expect(studioPreamble()).toContain(specs.join(", "));
  });

  test("is pure: it composes the same text every time", () => {
    expect(studioPreamble()).toBe(studioPreamble());
  });
});
