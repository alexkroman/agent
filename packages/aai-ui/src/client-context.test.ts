// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

// biome-ignore lint/suspicious/noDeprecatedImports: preact v10 render API is current
import { h, render } from "preact";
import { describe, expect, test } from "vitest";
import { ClientConfigProvider, useClientConfig } from "./client-context.ts";

describe("client-context", () => {
  test("useClientConfig returns default empty config outside provider", () => {
    let config: ReturnType<typeof useClientConfig> | undefined;
    function Probe() {
      config = useClientConfig();
      return null;
    }
    const container = document.createElement("div");
    render(h(Probe, null), container);
    expect(config).toEqual({});
  });

  test("ClientConfigProvider provides config to children", () => {
    let config: ReturnType<typeof useClientConfig> | undefined;
    function Probe() {
      config = useClientConfig();
      return null;
    }
    const container = document.createElement("div");
    render(
      h(
        ClientConfigProvider,
        { value: { title: "Test Agent", theme: { bg: "#fff" } } },
        h(Probe, null),
      ),
      container,
    );
    expect(config).toEqual({ title: "Test Agent", theme: { bg: "#fff" } });
  });
});
