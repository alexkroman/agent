// Copyright 2025 the AAI authors. MIT license.

import { h, render } from "preact";
import { describe, expect, test } from "vitest";
import { withDOM } from "./_test_utils.ts";
import { MountConfigProvider, useMountConfig } from "./mount_context.ts";

describe("mount_context", () => {
  test(
    "useMountConfig returns default empty config outside provider",
    withDOM((container) => {
      let config: ReturnType<typeof useMountConfig> | undefined;
      function Probe() {
        config = useMountConfig();
        return null;
      }
      render(h(Probe, null), container);
      expect(config).toEqual({});
    }),
  );

  test(
    "MountConfigProvider provides config to children",
    withDOM((container) => {
      let config: ReturnType<typeof useMountConfig> | undefined;
      function Probe() {
        config = useMountConfig();
        return null;
      }
      render(
        h(
          MountConfigProvider,
          { value: { title: "Test Agent", theme: { bg: "#fff" } } },
          h(Probe, null),
        ),
        container,
      );
      expect(config).toEqual({ title: "Test Agent", theme: { bg: "#fff" } });
    }),
  );
});
