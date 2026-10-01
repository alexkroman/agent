// Copyright 2026 the AAI authors. MIT license.
/** `defineProvider` and `describeProvider` — the SDK half of a vendor registration. */

import { describe, expect, it } from "vitest";
import { defineProvider, describeProvider } from "./define-provider.ts";

describe("defineProvider / describeProvider", () => {
  const def = defineProvider({
    kind: "acme",
    stage: "stt",
    envVar: "ACME_API_KEY",
    label: "Acme",
    factory: "acmeStt",
    subpath: "stt",
  });

  it("freezes the definition", () => {
    expect(Object.isFrozen(def)).toBe(true);
  });

  it("stamps the kind and COPIES the options", () => {
    const options = { model: "a" };
    const d = describeProvider(def, options);
    options.model = "b";
    expect(d).toEqual({ kind: "acme", options: { model: "a" } });
  });
});
