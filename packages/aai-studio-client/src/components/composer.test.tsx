// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The chat composer: the field, the Send/Stop button and the queued
// follow-ups above them.
//
// The button and field states are asserted on static markup (moved from
// panes/chat.test.tsx); what a keypress or a click DOES is driven through the
// DOM below them. Which turn a queued message joins is chat-queue.ts's call,
// not the composer's — it only hands the text up.

import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { Composer } from "./composer.tsx";

const noop = (): void => undefined;

describe("Composer", () => {
  const composerProps = {
    disabled: false,
    placeholder: "p",
    value: "",
    onValueChange: noop,
    onSend: noop,
  };

  test("idle: shows an enabled Send button and no Stop", () => {
    const html = renderToStaticMarkup(<Composer {...composerProps} />);
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain('aria-label="Stop"');
  });

  test("while a turn streams, the button becomes an enabled Stop", () => {
    // The whole point of the stop button: a hung turn used to leave the
    // composer with nothing to click.
    const html = renderToStaticMarkup(<Composer {...composerProps} busy={true} onStop={noop} />);
    expect(html).toContain('aria-label="Stop"');
    expect(html).not.toContain('aria-label="Send"');
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
  });

  test("the input stays live while a turn streams, so a follow-up can be queued", () => {
    // It used to be disabled, which silently swallowed anything typed
    // mid-turn — the whole reason the queue exists.
    const html = renderToStaticMarkup(<Composer {...composerProps} busy={true} onStop={noop} />);
    expect(html).not.toMatch(/<textarea[^>]*\sdisabled=/);
  });

  test("the LLM being down is what disables the composer", () => {
    const html = renderToStaticMarkup(<Composer {...composerProps} disabled={true} />);
    expect(html).toMatch(/<textarea[^>]*\sdisabled=/);
    expect(html).toMatch(/<button[^>]*\sdisabled=/);
  });

  test("a sandbox still starting holds the send button but leaves the field live", () => {
    // Distinct from `disabled`: the wait is finite, so the message can be
    // written while it runs out. Only sending waits.
    const html = renderToStaticMarkup(<Composer {...composerProps} sendDisabled={true} />);
    expect(html).not.toMatch(/<textarea[^>]*\sdisabled=/);
    expect(html).toMatch(/<button[^>]*\sdisabled=/);
  });

  test("queued follow-ups render with a per-message dismiss", () => {
    const html = renderToStaticMarkup(
      <Composer
        {...composerProps}
        busy={true}
        onStop={noop}
        queued={[
          { id: "q0", text: "add tests" },
          { id: "q1", text: "fix lint" },
        ]}
      />,
    );
    expect(html).toContain("add tests");
    expect(html).toContain("fix lint");
    expect(html).toContain('aria-label="Remove queued message 1"');
    expect(html).toContain('aria-label="Remove queued message 2"');
  });
});

/** A composer whose field is held the way the panel holds it. */
function Controlled(props: {
  onSend: (text: string) => void;
  sendDisabled?: boolean;
  initial?: string;
}) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <Composer
      disabled={false}
      sendDisabled={props.sendDisabled ?? false}
      placeholder="Describe your agent…"
      value={value}
      onValueChange={setValue}
      onSend={props.onSend}
    />
  );
}

describe("Composer interaction", () => {
  test("Enter sends the TRIMMED text and clears the field", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Controlled onSend={onSend} />);
    const field = screen.getByPlaceholderText("Describe your agent…");
    await user.type(field, "  build a pizza bot  ");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledExactlyOnceWith("build a pizza bot");
    expect(field).toHaveValue("");
  });

  test("Shift+Enter is a newline, not a send", () => {
    const onSend = vi.fn();
    render(<Controlled onSend={onSend} initial="line one" />);
    fireEvent.keyDown(screen.getByPlaceholderText("Describe your agent…"), {
      key: "Enter",
      shiftKey: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("a blank field sends nothing", () => {
    const onSend = vi.fn();
    render(<Controlled onSend={onSend} initial="   " />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).not.toHaveBeenCalled();
  });

  test("a send held back by a starting sandbox KEEPS the text", () => {
    const onSend = vi.fn();
    render(<Controlled onSend={onSend} sendDisabled initial="make it italian" />);
    fireEvent.keyDown(screen.getByPlaceholderText("Describe your agent…"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Describe your agent…")).toHaveValue("make it italian");
  });

  test("Stop calls onStop and sends nothing, even with text in the field", () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    render(
      <Composer
        disabled={false}
        placeholder="p"
        value="a follow-up"
        onValueChange={noop}
        onSend={onSend}
        busy
        onStop={onStop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  test("a queued row's dismiss names that row's id", () => {
    const onRemoveQueued = vi.fn();
    render(
      <Composer
        disabled={false}
        placeholder="p"
        value=""
        onValueChange={noop}
        onSend={noop}
        queued={[
          { id: "q0", text: "add tests" },
          { id: "q1", text: "fix lint" },
        ]}
        onRemoveQueued={onRemoveQueued}
      />,
    );
    expect(screen.getByRole("list", { name: "Queued messages" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message 2" }));
    expect(onRemoveQueued).toHaveBeenCalledExactlyOnceWith("q1");
  });
});
