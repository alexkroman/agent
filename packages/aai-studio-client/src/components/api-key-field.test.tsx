// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The one control that stores an AssemblyAI key. What both callers depend on
// is WHEN the field clears: on a successful store only — a failed one keeps
// the draft and says why.

import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { fetchCallsWith, jsonResponse, renderWithClient, stubFetch } from "../_test-utils.ts";
import { queryKeys } from "../query-keys.ts";
import { ApiKeyField } from "./api-key-field.tsx";

const field = () => screen.getByLabelText("API key");
const save = () => screen.getByRole("button", { name: "Save key" });

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
  test("the button is disabled until there is a non-blank draft", async () => {
    const user = userEvent.setup();
    renderField();
    expect(save()).toBeDisabled();
    await user.type(field(), "   ");
    expect(save()).toBeDisabled();
    await user.clear(field());
    await user.type(field(), "k");
    expect(save()).toBeEnabled();
  });

  test("the field is a password input with no autocomplete", () => {
    renderField();
    expect(field()).toHaveAttribute("type", "password");
    expect(field()).toHaveAttribute("autocomplete", "off");
  });

  test("stores the TRIMMED key with the bearer, clears, notes it, and invalidates the account", async () => {
    const user = userEvent.setup();
    const mock = stubFetch({ "PUT /studio/account/key": () => jsonResponse({ ok: true }) });
    const onSaved = vi.fn();
    const { client } = renderField(onSaved);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.type(field(), "  aai_key_123  ");
    await user.click(save());

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const [put] = fetchCallsWith(mock, "PUT");
    expect(put?.init.body).toBe(JSON.stringify({ apiKey: "aai_key_123" }));
    expect(new Headers(put?.init.headers).get("Authorization")).toBe("Bearer bearer-1");
    expect(field()).toHaveValue("");
    expect(screen.getByText("Key saved.")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.accounts });
  });

  test("Enter submits the same way the button does", async () => {
    const user = userEvent.setup();
    const mock = stubFetch({ "PUT /studio/account/key": () => jsonResponse({ ok: true }) });
    renderField();
    await user.type(field(), "k2{Enter}");
    await waitFor(() => expect(fetchCallsWith(mock, "PUT")).toHaveLength(1));
  });

  test("a failed store keeps the draft and shows the server's own sentence", async () => {
    stubFetch({
      "PUT /studio/account/key": () => jsonResponse({ error: "That key was rejected" }, 400),
    });
    const user = userEvent.setup();
    const onSaved = vi.fn();
    renderField(onSaved);
    await user.type(field(), "bad-key");
    await user.click(save());

    expect(await screen.findByText("That key was rejected")).toBeInTheDocument();
    expect(field()).toHaveValue("bad-key");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByText("Key saved.")).toBeNull();
  });

  test("the saved note goes away on the next edit", async () => {
    const user = userEvent.setup();
    stubFetch({ "PUT /studio/account/key": () => jsonResponse({ ok: true }) });
    renderField();
    await user.type(field(), "k");
    await user.click(save());
    expect(await screen.findByText("Key saved.")).toBeInTheDocument();
    await user.type(field(), "n");
    expect(screen.queryByText("Key saved.")).toBeNull();
  });
});
