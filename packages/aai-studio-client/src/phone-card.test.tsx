// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The API pane's "Phone number" card: the per-carrier webhook URLs and the
// signing-secret hint beside each one. It lived in Settings until the API pane
// existed — a webhook URL is how a carrier CALLS this agent, which is that
// pane's subject.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PhoneCard, phoneWebhookUrl, secretState } from "./phone-card.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("phoneWebhookUrl", () => {
  test("names the carrier explicitly rather than relying on the default", () => {
    // The URL is pasted into a carrier console once and never revisited, so
    // it must not depend on what the platform happens to default to.
    expect(phoneWebhookUrl("https://build.test", "demo-x7k2mq", "twilio")).toBe(
      "https://build.test/demo-x7k2mq/phone?carrier=twilio",
    );
    expect(phoneWebhookUrl("https://build.test", "demo-x7k2mq", "telnyx")).toBe(
      "https://build.test/demo-x7k2mq/phone?carrier=telnyx",
    );
  });
});

describe("secretState", () => {
  test.each([
    ["missing", [], []],
    ["live", ["TWILIO_AUTH_TOKEN"], []],
    ["pending", ["TWILIO_AUTH_TOKEN"], ["TWILIO_AUTH_TOKEN"]],
  ] as const)("reports %s", (expected, names, pending) => {
    expect(secretState("TWILIO_AUTH_TOKEN", names, pending)).toBe(expected);
  });

  test("a pending secret is not reported as live", () => {
    // It is visible in Settings → Secrets but has not reached the published
    // agent, so verification is not running — saying "set" would tell someone
    // their webhook is protected while it accepts anything.
    expect(secretState("TELNYX_PUBLIC_KEY", ["TELNYX_PUBLIC_KEY"], ["TELNYX_PUBLIC_KEY"])).not.toBe(
      "live",
    );
  });
});

describe("PhoneCard", () => {
  const props = { secretNames: [], pendingSecrets: [] };

  test("shows a webhook URL per carrier, built from the published slug", () => {
    render(<PhoneCard deployedSlug="demo-x7k2mq" {...props} />);
    const origin = window.location.origin;
    expect(screen.getByText(`${origin}/demo-x7k2mq/phone?carrier=twilio`)).toBeTruthy();
    expect(screen.getByText(`${origin}/demo-x7k2mq/phone?carrier=telnyx`)).toBeTruthy();
  });

  test("names each carrier's signing secret when it is not set", () => {
    render(<PhoneCard deployedSlug="demo" {...props} />);
    expect(screen.getByText("TWILIO_AUTH_TOKEN")).toBeTruthy();
    expect(screen.getByText("TELNYX_PUBLIC_KEY")).toBeTruthy();
    expect(screen.getAllByText(/Add/).length).toBe(2);
  });

  test("says where to find the value, so the hint is actionable", () => {
    render(<PhoneCard deployedSlug="demo" {...props} />);
    expect(screen.getByText(/Twilio Console/)).toBeTruthy();
    expect(screen.getByText(/Telnyx Portal/)).toBeTruthy();
  });

  test("reports a configured secret as verifying calls", () => {
    render(
      <PhoneCard deployedSlug="demo" secretNames={["TWILIO_AUTH_TOKEN"]} pendingSecrets={[]} />,
    );
    expect(screen.getByText(/is set — calls are verified/)).toBeTruthy();
  });

  test("reports a saved-but-undelivered secret as not yet verifying", () => {
    render(
      <PhoneCard
        deployedSlug="demo"
        secretNames={["TWILIO_AUTH_TOKEN"]}
        pendingSecrets={["TWILIO_AUTH_TOKEN"]}
      />,
    );
    expect(screen.getByText(/next publish/)).toBeTruthy();
    expect(screen.queryByText(/is set — calls are verified/)).toBeNull();
  });

  test("asks for a publish rather than showing a URL that would hang up on callers", () => {
    // An unpublished slug resolves to nothing: the caller hears the
    // agent-not-found message. No URL is a better answer than a dead one.
    render(<PhoneCard {...props} />);
    expect(screen.getByText(/Publish this project/)).toBeTruthy();
    expect(screen.queryByText(/carrier=twilio/)).toBeNull();
  });

  test("copies a carrier's URL and flashes only that button", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<PhoneCard deployedSlug="demo" {...props} />);

    fireEvent.click(screen.getByLabelText("Copy the Twilio webhook URL"));
    await vi.waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/demo/phone?carrier=twilio`);
    // The other carrier's button is untouched — the flash is keyed by text.
    expect(screen.getByLabelText("Copy the Telnyx webhook URL").textContent).toBe("Copy");
  });

  test("a clipboard-less context flashes a failure rather than throwing", () => {
    vi.stubGlobal("navigator", {});
    render(<PhoneCard deployedSlug="demo" {...props} />);
    expect(() =>
      fireEvent.click(screen.getByLabelText("Copy the Twilio webhook URL")),
    ).not.toThrow();
    expect(screen.getByText("Failed")).toBeTruthy();
  });
});
