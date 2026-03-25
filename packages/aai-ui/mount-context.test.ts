// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { h, render } from "preact";
import { describe, expect, test } from "vitest";
import { MountConfigProvider, useMountConfig } from "./mount-context.ts";

describe("mount-context", () => {
  test("useMountConfig returns default empty config outside provider", () => {
    let config: ReturnType<typeof useMountConfig> | undefined;
    function Probe() {
      config = useMountConfig();
      return null;
    }
    const container = document.createElement("div");
    render(h(Probe, null), container);
    expect(config).toEqual({});
  });

  test("MountConfigProvider provides config to children", () => {
    let config: ReturnType<typeof useMountConfig> | undefined;
    function Probe() {
      config = useMountConfig();
      return null;
    }
    const container = document.createElement("div");
    render(
      h(
        MountConfigProvider,
        { value: { title: "Test Agent", theme: { bg: "#fff" } } },
        h(Probe, null),
      ),
      container,
    );
    expect(config).toEqual({ title: "Test Agent", theme: { bg: "#fff" } });
  });
});
