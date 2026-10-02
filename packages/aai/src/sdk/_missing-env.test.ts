// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { missingEnvMessage } from "./_missing-env.ts";

describe("missingEnvMessage", () => {
  test("names the variable, and both ways to set it", () => {
    const message = missingEnvMessage("NOTES_API_KEY");
    expect(message).toMatch(/^Missing NOTES_API_KEY in the agent env\./);
    // `aai dev` reads `.env`; a deployed agent reads its secrets.
    expect(message).toContain(".env");
    expect(message).toContain("`aai secret put NOTES_API_KEY`");
  });

  test("points at `requiredEnv`, which is what makes a deploy check it", () => {
    expect(missingEnvMessage("X")).toContain("`requiredEnv`");
  });
});
