// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useTheme()` hands a component a JavaScript object, so every styled node in
 * the template tree carries an inline `style={{ }}` — measured, close to one
 * inline style per `theme.` read. A Tailwind class cannot see a JavaScript
 * object, so the provider also publishes the five fields as custom properties
 * and `styles.css` maps them into Tailwind's `--color-*` namespace.
 *
 * Three things this suite holds, all of which are silent when broken:
 *
 * - The variables really land on `:root`, and are restored rather than removed
 *   on unmount (a host page may have set its own before we mounted).
 * - The page background is STILL painted imperatively on `html` and `body`. A
 *   variable only paints where a rule consumes it, and those two elements are
 *   the ones nothing in this package renders — dropping that is how a cream
 *   theme ends up letterboxed in black on a wide viewport.
 * - The fallbacks written into `styles.css` are the DEFAULT THEME. They are the
 *   only thing making `bg-aai-surface` work on a page that mounts no provider,
 *   and nothing else compares the two copies.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, test } from "vitest";
import { ThemeProvider } from "./context.ts";
import type { ClientTheme } from "./types.ts";

const VARS = ["--aai-bg", "--aai-surface", "--aai-text", "--aai-border", "--aai-primary"] as const;

function varsOnRoot(): Record<string, string> {
  const { style } = document.documentElement;
  return Object.fromEntries(VARS.map((name) => [name, style.getPropertyValue(name)]));
}

function mount(theme?: ClientTheme) {
  return render(createElement(ThemeProvider, { value: theme }, "x"));
}

describe("the theme as CSS custom properties", () => {
  test("publishes all five defaults on :root", () => {
    mount();
    expect(varsOnRoot()).toEqual({
      "--aai-bg": "#FBF8F2",
      "--aai-surface": "#FFFFFF",
      "--aai-text": "#1B1A18",
      "--aai-border": "#DCD7CC",
      "--aai-primary": "#3F2BC1",
    });
  });

  test("a client({ theme }) override reaches the variables, not just useTheme()", () => {
    mount({ primary: "#ff0000", surface: "#101010" });
    const vars = varsOnRoot();
    expect(vars["--aai-primary"]).toBe("#ff0000");
    expect(vars["--aai-surface"]).toBe("#101010");
    // Unnamed fields still get the default, so a partial theme is not a hole.
    expect(vars["--aai-text"]).toBe("#1B1A18");
  });

  test("republishes when a field other than the background changes", () => {
    // `bg` had a repaint test all along; the other four had nothing watching
    // them, and a dependency array that named only `bg` would pass every other
    // assertion here.
    const view = mount({ primary: "#111111" });
    view.rerender(createElement(ThemeProvider, { value: { primary: "#222222" } }, "x"));
    expect(varsOnRoot()["--aai-primary"]).toBe("#222222");
  });

  test("restores what it found on unmount rather than deleting it", () => {
    // A host page that set its own tokens before mounting a client keeps them.
    document.documentElement.style.setProperty("--aai-primary", "#abcdef");
    const view = mount({ primary: "#000000" });
    expect(varsOnRoot()["--aai-primary"]).toBe("#000000");
    view.unmount();
    expect(document.documentElement.style.getPropertyValue("--aai-primary")).toBe("#abcdef");
    // One it did NOT find is removed, not left behind as a stale token.
    expect(document.documentElement.style.getPropertyValue("--aai-border")).toBe("");
    document.documentElement.style.removeProperty("--aai-primary");
  });

  test("still paints html AND body, so a wide viewport is not letterboxed", () => {
    // The regression this guards is invisible in a unit render and obvious on a
    // 2560px monitor. It has happened once.
    mount({ bg: "#123456" });
    expect(document.body.style.background).toBe("rgb(18, 52, 86)");
    expect(document.documentElement.style.background).toBe("rgb(18, 52, 86)");
  });
});

describe("styles.css agrees with the default theme", () => {
  // A path rather than a `new URL(…, import.meta.url)`: under jsdom the global
  // `URL` is jsdom's own, which `node:fs` rejects as "must be of scheme file".
  const css = readFileSync(join(import.meta.dirname, "../styles.css"), "utf8");

  test.each([
    ["bg", "#fbf8f2"],
    ["surface", "#ffffff"],
    ["text", "#1b1a18"],
    ["border", "#dcd7cc"],
    ["primary", "#3f2bc1"],
  ])("--color-aai-%s falls back to the default theme's own value", (field, fallback) => {
    expect(css).toContain(`--color-aai-${field}: var(--aai-${field}, ${fallback});`);
  });

  test("the fallbacks are the values the provider publishes", () => {
    // The two copies compared directly: a default changed in `context.ts` and
    // not in `styles.css` leaves every Tailwind utility on the OLD palette for
    // any page with no provider, which no other test can see.
    mount();
    for (const [name, value] of Object.entries(varsOnRoot())) {
      expect(css.toLowerCase()).toContain(`var(${name}, ${value.toLowerCase()})`);
    }
  });
});
