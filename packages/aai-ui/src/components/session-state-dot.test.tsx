// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * The dot is the one thing every custom chrome's header rebuilt, and the three
 * things a reviewer cannot see are missing from a copy are the three asserted
 * here: that the palette lookup is EXHAUSTIVE (a `Record` over `AgentState`,
 * so a state added upstream is a compile error in the caller rather than an
 * unpainted dot), that the label falls back to `AGENT_STATE_LABELS` for every
 * state a page did not name, and that the pulse follows the state rather than a
 * prop the caller has to keep in step with it.
 */

import { render } from "@testing-library/react";
import { act } from "react";
import { describe, expect, test } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { AGENT_STATE_LABELS } from "../agent-state-labels.ts";
import { SessionProvider } from "../context.ts";
import type { AgentState } from "../types.ts";
import { SessionStateDot, type SessionStateDotProps, StateDot } from "./session-state-dot.tsx";

const COLORS = {
  disconnected: "#111111",
  connecting: "#222222",
  ready: "#333333",
  listening: "#444444",
  thinking: "#555555",
  speaking: "#666666",
  error: "#777777",
} satisfies Record<AgentState, string>;

const STATES: readonly AgentState[] = [
  "disconnected",
  "connecting",
  "ready",
  "listening",
  "thinking",
  "speaking",
  "error",
];

function mount(state: AgentState, props: Partial<SessionStateDotProps> = {}) {
  const core = createMockSessionCore({ state });
  const view = render(
    <SessionProvider value={core}>
      <SessionStateDot colors={COLORS} {...props} />
    </SessionProvider>,
  );
  const wrapper = view.container.firstElementChild as HTMLElement;
  const dot = wrapper.firstElementChild as HTMLElement;
  const label = wrapper.lastElementChild as HTMLElement;
  return { core, view, wrapper, dot, label };
}

describe("SessionStateDot", () => {
  test("paints the dot from the palette for every state, and titles it with the raw state", () => {
    for (const state of STATES) {
      const { dot } = mount(state);
      expect(dot.style.background).toBe(hex(COLORS[state]));
      expect(dot.title).toBe(state);
    }
  });

  test("writes the colour to `color` too, so a currentColor glow needs no palette restated", () => {
    const { dot } = mount("listening");
    expect(dot.style.color).toBe(hex(COLORS.listening));
  });

  test("labels every state from AGENT_STATE_LABELS when given no words of its own", () => {
    for (const state of STATES) {
      expect(mount(state).label.textContent).toBe(AGENT_STATE_LABELS[state]);
    }
  });

  test("a partial `labels` overrides the named states and leaves the rest to the defaults", () => {
    const labels = { speaking: "Narrating", thinking: "PROCESSING" };
    expect(mount("speaking", { labels }).label.textContent).toBe("Narrating");
    expect(mount("thinking", { labels }).label.textContent).toBe("PROCESSING");
    expect(mount("listening", { labels }).label.textContent).toBe(AGENT_STATE_LABELS.listening);
  });

  test("pulses while listening and (faster) while thinking, and is still otherwise", () => {
    expect(mount("listening").dot.style.animation).toMatch(/aai-pulse 1500ms/);
    expect(mount("thinking").dot.style.animation).toMatch(/aai-pulse 800ms/);
    for (const state of ["disconnected", "connecting", "ready", "speaking", "error"] as const) {
      expect(mount(state).dot.style.animation).toBe("none");
    }
  });

  test("pulse={false} keeps every state still", () => {
    expect(mount("listening", { pulse: false }).dot.style.animation).toBe("none");
    expect(mount("thinking", { pulse: false }).dot.style.animation).toBe("none");
  });

  test("follows the session: a state change repaints without a re-mount", () => {
    const { core, dot, label } = mount("ready");
    act(() => core.update({ state: "thinking" }));
    expect(dot.style.background).toBe(hex(COLORS.thinking));
    expect(label.textContent).toBe(AGENT_STATE_LABELS.thinking);
  });

  test("exposes the state on the wrapper for a chrome's own CSS", () => {
    expect(mount("error").wrapper.dataset.state).toBe("error");
  });

  test("dotClassName REPLACES the default size; className and labelClassName are appended", () => {
    const plain = mount("ready");
    expect(plain.dot.className).toContain("w-2 h-2");
    expect(plain.dot.className).toContain("rounded-full");

    const sized = mount("ready", {
      dotClassName: "w-2.5 h-2.5",
      className: "text-xs",
      labelClassName: "uppercase",
    });
    expect(sized.dot.className).toContain("w-2.5 h-2.5");
    expect(sized.dot.className).not.toContain("w-2 h-2");
    expect(sized.dot.className).toContain("rounded-full");
    expect(sized.wrapper.className).toContain("inline-flex");
    expect(sized.wrapper.className).toContain("text-xs");
    expect(sized.label.className).toBe("uppercase");
  });
});

describe("StateDot", () => {
  test("is the shared dot: a colour and a pulse length, nothing read from a session", () => {
    const { container } = render(<StateDot color="#abcdef" pulseMs={1600} className="w-1 h-1" />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot.style.background).toBe(hex("#abcdef"));
    expect(dot.style.animation).toBe("aai-pulse 1600ms ease-in-out infinite");
    expect(dot.className).toContain("w-1 h-1");
  });

  test("a null pulse is a still dot", () => {
    const { container } = render(<StateDot color="#abcdef" pulseMs={null} />);
    expect((container.firstElementChild as HTMLElement).style.animation).toBe("none");
  });
});

/** jsdom normalises a hex colour to `rgb(r, g, b)`; compare in that form. */
function hex(color: string): string {
  const n = Number.parseInt(color.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
