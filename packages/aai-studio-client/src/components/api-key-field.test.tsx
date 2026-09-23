// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The one control that stores an AssemblyAI key. What both callers depend on
// is WHEN the field clears: on a successful store only — a failed one keeps
// the draft and says why.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  button,
  fetchCallsWith,
  input,
  jsonResponse,
  renderWithClient,
  stubFetch,
} from "../_test-utils.ts";
import { queryKeys } from "../query-keys.ts";
import { ApiKeyField } from "./api-key-field.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderField(onSaved?: () => void) {
  return renderWithClient(
    <ApiKeyField
      bearer="bearer-1"
      submitLabel="Save key"
      placeholder="Paste your key"
      ariaLabel="API key"
      onSaved={onSaved}
      savedNote={<p>Key saved.</p>}
    />,
  );
}

describe("ApiKeyField", () => {
  test("the button is disabled until there is a non-blank draft", () => {
    renderField();
    expect(button("Save key").disabled).toBe(true);
    fireEvent.change(input("API key"), { target: { value: "   " } });
    expect(button("Save key").disabled).toBe(true);
    fireEvent.change(input("API key"), { target: { value: "k" } });
    expect(button("Save key").disabled).toBe(false);
  });

  test("the field is a password input with no autocomplete", () => {
    renderField();
    expect(input("API key").type).toBe("password");
    expect(input("API key").getAttribute("autocomplete")).toBe("off");
  });

  test("stores the TRIMMED key with the bearer, clears, notes it, and invalidates the account", async () => {
    const mock = stubFetch({ "PUT /studio/account/key": () => jsonResponse({ ok: true }) });
    const onSaved = vi.fn();
    const { client } = renderField(onSaved);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    fireEvent.change(input("API key"), { target: { value: "  aai_key_123  " } });
    fireEvent.click(button("Save key"));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const [put] = fetchCallsWith(mock, "PUT");
    expect(put?.init.body).toBe(JSON.stringify({ apiKey: "aai_key_123" }));
    expect(new Headers(put?.init.headers).get("Authorization")).toBe("Bearer bearer-1");
    expect(input("API key").value).toBe("");
    expect(screen.getByText("Key saved.")).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.accounts });
  });

  test("Enter submits the same way the button does", async () => {
    const mock = stubFetch({ "PUT /studio/account/key": () => jsonResponse({ ok: true }) });
    renderField();
    fireEvent.change(input("API key"), { target: { value: "k2" } });
    fireEvent.keyDown(input("API key"), { key: "Enter" });
    await waitFor(() => expect(fetchCallsWith(mock, "PUT")).toHaveLength(1));
  });

  test("a failed store keeps the draft and shows the server's own sentence", async () => {
    stubFetch({
      "PUT /studio/account/key": () => jsonResponse({ error: "That key was rejected" }, 400),
    });
    const onSaved = vi.fn();
    renderField(onSaved);
    fireEvent.change(input("API key"), { target: { value: "bad-key" } });
    fireEvent.click(button("Save key"));

    expect(await screen.findByText("That key was rejected")).toBeTruthy();
    expect(input("API key").value).toBe("bad-key");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByText("Key saved.")).toBeNull();
  });

  test("the saved note goes away on the next edit", async () => {
    stubFetch({ "PUT /studio/account/key": () => jsonResponse({ ok: true }) });
    renderField();
    fireEvent.change(input("API key"), { target: { value: "k" } });
    fireEvent.click(button("Save key"));
    expect(await screen.findByText("Key saved.")).toBeTruthy();
    fireEvent.change(input("API key"), { target: { value: "n" } });
    expect(screen.queryByText("Key saved.")).toBeNull();
  });
});
