// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Account panel: the one place a signed-in user can replace this
// account's stored AssemblyAI key. Write-only — the browser never reads the
// key back, so the panel shows `hasKey` and nothing else about it.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  button,
  fetchCallsWith,
  input,
  jsonResponse,
  renderWithClient,
  stubFetch,
} from "./_test-utils.ts";
import { AccountMenu } from "./account-menu.tsx";

function renderMenu(open: boolean, onClose = vi.fn()) {
  const result = renderWithClient(
    <AccountMenu open={open} bearer="session-token" onClose={onClose} />,
  );
  return { ...result, onClose };
}

const ACCOUNT = () => jsonResponse({ email: "a@b.c", hasKey: true });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountMenu", () => {
  test("renders nothing while closed, and asks the server nothing", () => {
    const fetchMock = stubFetch({});
    const { container } = renderMenu(false);
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("shows who is signed in", async () => {
    stubFetch({ "/studio/account": ACCOUNT });
    renderMenu(true);
    await waitFor(() => {
      expect(screen.getByText("a@b.c")).toBeTruthy();
    });
  });

  test("saving PUTs the new key, clears the field, and confirms", async () => {
    const fetchMock = stubFetch({
      "/studio/account": ACCOUNT,
      "PUT /studio/account/key": () => jsonResponse({ ok: true }),
    });
    renderMenu(true);
    const field = input("New AssemblyAI API key");
    // Write-only: the stored key is never fetched, only its existence.
    expect(field.value).toBe("");
    expect(field.getAttribute("type")).toBe("password");

    fireEvent.change(field, { target: { value: "  new-key  " } });
    fireEvent.click(screen.getByRole("button", { name: "Update key" }));

    await waitFor(() => {
      expect(screen.getByText(/Key updated/)).toBeTruthy();
    });
    const [put] = fetchCallsWith(fetchMock, "PUT");
    expect(put?.url).toBe("/studio/account/key");
    // Trimmed — a pasted key routinely carries whitespace.
    expect(JSON.parse(String(put?.init.body))).toEqual({ apiKey: "new-key" });
    expect(field.value).toBe("");
  });

  test("Enter submits, so the field works without reaching for the button", async () => {
    const fetchMock = stubFetch({
      "/studio/account": ACCOUNT,
      "PUT /studio/account/key": () => jsonResponse({ ok: true }),
    });
    renderMenu(true);
    const field = input("New AssemblyAI API key");
    fireEvent.change(field, { target: { value: "typed-key" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => {
      expect(fetchCallsWith(fetchMock, "PUT").length).toBeGreaterThan(0);
    });
  });

  test("an empty field cannot be submitted", () => {
    stubFetch({ "/studio/account": ACCOUNT });
    renderMenu(true);
    expect(button("Update key").disabled).toBe(true);
  });

  test("a rejected key stays on screen as an error", async () => {
    stubFetch({
      "/studio/account": ACCOUNT,
      "PUT /studio/account/key": () => jsonResponse({ error: "Invalid API key" }, 400),
    });
    renderMenu(true);
    fireEvent.change(screen.getByLabelText("New AssemblyAI API key"), {
      target: { value: "bad-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update key" }));
    await waitFor(() => {
      expect(screen.getByText("Invalid API key")).toBeTruthy();
    });
    expect(screen.queryByText(/Key updated/)).toBeNull();
  });

  test("a successful save re-brokers the chat session, which holds the old key", async () => {
    stubFetch({
      "/studio/account": ACCOUNT,
      "PUT /studio/account/key": () => jsonResponse({ ok: true }),
    });
    const { client } = renderMenu(true);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.change(screen.getByLabelText("New AssemblyAI API key"), {
      target: { value: "new-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update key" }));
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-session"] });
    });
  });

  test("Escape closes the panel", async () => {
    stubFetch({ "/studio/account": ACCOUNT });
    const { onClose } = renderMenu(true);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
