// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Secrets pane — a pane of its own, talking to
// /studio/projects/:project/secret. The server writes both of a project's
// agents AND the project's own record, so the pane mirrors nothing and needs
// no publish first, and a change here writes nothing into the conversation.
//
// Two forms, one endpoint: a NAME/VALUE pair for the ordinary case (one key,
// its value in a password field) and a .env textarea for the bulk one. What
// these tests hold is the split — each form clears only on its own success,
// refuses a platform-managed name by name rather than saving it into a list it
// would then be absent from, and reports its failure in one place.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { type UserEvent, userEvent } from "@testing-library/user-event";
import { describe, expect, type Mock, test, vi } from "vitest";
import { fetchCallsWith, jsonResponse, renderWithClient, stubFetch } from "../_test-utils.ts";
import { SecretsPane } from "./secrets.tsx";

/** How many requests this mock saw for one path. */
function callsTo(fetchMock: Mock<typeof fetch>, path: string): number {
  return fetchMock.mock.calls.filter(([secret]) => String(secret) === path).length;
}

function renderPane() {
  renderWithClient(<SecretsPane bearer="sk-test" project="demo" />);
}

/** The .env box — the pane clears it on a successful save, only then. */
function pasteBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("OPENAI_API_KEY=...");
}

/** Fill the one-key form. */
async function typePair(user: UserEvent, name: string, value: string): Promise<void> {
  await user.type(screen.getByLabelText("Name"), name);
  await user.type(screen.getByLabelText("Value"), value);
}

/** Paste a .env into the bulk box, the way it arrives in practice. */
async function pasteEnv(user: UserEvent, text: string): Promise<void> {
  await user.click(pasteBox());
  await user.paste(text);
}

const LIST = "/studio/projects/demo/secret";

describe("SecretsPane", () => {
  test("the pane leads with adding a key, then what is attached, then the paste box", async () => {
    // Adding is the common case and comes first; the .env box is the power
    // path and comes last. Card titles are eyebrow spans, and inside this pane
    // every one of them is a section title.
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse({ vars: [], pending: [] }) });
    renderPane();
    expect(await screen.findByText("Attached keys")).toBeInTheDocument();
    const titles = [...document.querySelectorAll(".eyebrow")].map((el) => el.textContent);
    expect(titles).toEqual(["Add a secret", "Attached keys", "Paste a .env"]);
  });

  test("usable with nothing published — no publish-first gate", async () => {
    // An agent needs its provider key to RUN, so requiring a publish first
    // asked for the one order that cannot work: ship it broken, attach the
    // key, ship again.
    const fetchMock = stubFetch({ [`GET ${LIST}`]: () => jsonResponse({ vars: [] }) });
    renderPane();
    await waitFor(() => expect(callsTo(fetchMock, LIST)).toBe(1));
    expect(screen.queryByText(/Publish the project first/)).toBeNull();
    expect(screen.getByText("Add secret")).toBeInTheDocument();
  });

  test("lists the project's secret names, live ones marked as such", async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ vars: ["OPENAI_API_KEY"], pending: [] }),
    });
    renderPane();
    expect(await screen.findByText("OPENAI_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.getByText("Attached keys · 1")).toBeInTheDocument();
  });

  test("a name no deployed agent carries yet says so, rather than reading as live", async () => {
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ vars: ["LIVE_KEY", "NEW_KEY"], pending: ["NEW_KEY"] }),
    });
    renderPane();
    expect(await screen.findByText("NEW_KEY")).toBeInTheDocument();
    expect(screen.getAllByText("on next deploy")).toHaveLength(1);
    expect(screen.getAllByText("live")).toHaveLength(1);
  });

  test("an empty project says so, rather than showing an empty list frame", async () => {
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse({ vars: [] }) });
    renderPane();
    expect(await screen.findByText(/No secrets yet/)).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  test("adding one key PUTs just that pair and clears both fields", async () => {
    const user = userEvent.setup();
    // The cleared fields are the form's whole report of a successful save, now
    // that nothing is written into the chat.
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ vars: [] }),
      [`PUT ${LIST}`]: () => jsonResponse({ vars: ["MY_KEY"] }),
    });
    renderPane();
    await typePair(user, "MY_KEY", "super-secret-value");
    fireEvent.click(screen.getByText("Add secret"));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue(""));
    expect(screen.getByLabelText("Value")).toHaveValue("");
    const [put] = fetchCallsWith(fetchMock, "PUT");
    expect(put?.init.body).toBe(JSON.stringify({ MY_KEY: "super-secret-value" }));
  });

  test("the value never appears in plaintext", () => {
    // The one thing this form does that a KEY=value textarea cannot.
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse({ vars: [] }) });
    renderPane();
    expect(screen.getByLabelText("Value")).toHaveAttribute("type", "password");
  });

  test("Enter in either field submits the pair", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ vars: [] }),
      [`PUT ${LIST}`]: () => jsonResponse({ vars: ["MY_KEY"] }),
    });
    renderPane();
    await typePair(user, "MY_KEY", "v{Enter}");
    await waitFor(() => expect(fetchCallsWith(fetchMock, "PUT")).toHaveLength(1));
  });

  test("Add secret stays disabled until both halves are there", async () => {
    const user = userEvent.setup();
    // A name with no value would store an empty string, which reads to a tool
    // exactly like a key that was never set.
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse({ vars: [] }) });
    renderPane();
    const add = screen.getByText("Add secret");
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText("Name"), "MY_KEY");
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText("Value"), "v");
    expect(add).toBeEnabled();
  });

  test("a name no shell could read is refused here, not by the server", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ [`GET ${LIST}`]: () => jsonResponse({ vars: [] }) });
    renderPane();
    await waitFor(() => expect(callsTo(fetchMock, LIST)).toBe(1));
    await typePair(user, "my key", "v");
    fireEvent.click(screen.getByText("Add secret"));
    expect(screen.getByText(/isn't a valid environment variable name/)).toBeInTheDocument();
    expect(fetchCallsWith(fetchMock, "PUT")).toHaveLength(0);
    // The pair survives the refusal — it is what the user would retype.
    expect(screen.getByLabelText("Name")).toHaveValue("my key");
  });

  test("a failed add surfaces its error and KEEPS the pair", async () => {
    const user = userEvent.setup();
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ vars: [] }),
      [`PUT ${LIST}`]: () => jsonResponse({ error: "vault unavailable" }, 503),
    });
    renderPane();
    await typePair(user, "A", "1");
    fireEvent.click(screen.getByText("Add secret"));
    expect(await screen.findByText("vault unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("A");
    expect(screen.getByLabelText("Value")).toHaveValue("1");
  });

  test("a .env paste saves every key in one request and clears the box", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ vars: [] }),
      [`PUT ${LIST}`]: () => jsonResponse({ vars: ["A", "B"] }),
    });
    renderPane();
    await pasteEnv(user, "A=1\nB=2");
    fireEvent.click(screen.getByText("Save secrets"));
    await waitFor(() => expect(pasteBox()).toHaveValue(""));
    const puts = fetchCallsWith(fetchMock, "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.init.body).toBe(JSON.stringify({ A: "1", B: "2" }));
  });

  test("saving an empty paste box is a no-op — no request at all", async () => {
    const fetchMock = stubFetch({ [`GET ${LIST}`]: () => jsonResponse({ vars: [] }) });
    renderPane();
    await waitFor(() => expect(callsTo(fetchMock, LIST)).toBe(1));
    fireEvent.click(screen.getByText("Save secrets"));
    expect(callsTo(fetchMock, LIST)).toBe(1);
  });

  test("a failed paste reports itself ONCE — the two forms don't share an error", async () => {
    const user = userEvent.setup();
    // The reason there are two mutations rather than one: `error` and
    // `isPending` are read beside the button that fired them.
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ vars: [] }),
      [`PUT ${LIST}`]: () => jsonResponse({ error: "vault unavailable" }, 503),
    });
    renderPane();
    await pasteEnv(user, "A=1");
    fireEvent.click(screen.getByText("Save secrets"));
    await waitFor(() => expect(screen.getAllByText("vault unavailable")).toHaveLength(1));
    expect(pasteBox()).toHaveValue("A=1");
  });

  test("a failed listing surfaces the server's error message", async () => {
    stubFetch({ [`GET ${LIST}`]: () => jsonResponse({ error: "unauthorized" }, 401) });
    renderPane();
    expect(await screen.findByText("unauthorized")).toBeInTheDocument();
    // A read that failed is not an empty project.
    expect(screen.queryByText(/No secrets yet/)).toBeNull();
  });

  test("deleting confirms first, then DELETEs and re-reads the list", async () => {
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ vars: ["OLD_KEY"] }),
      [`DELETE ${LIST}/OLD_KEY`]: () => jsonResponse({ vars: [] }),
    });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    renderPane();
    expect(await screen.findByText("OLD_KEY")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Delete"));
    expect(callsTo(fetchMock, `${LIST}/OLD_KEY`)).toBe(0);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(callsTo(fetchMock, `${LIST}/OLD_KEY`)).toBe(1));
    // The invalidation is what makes the row disappear once the server agrees.
    await waitFor(() => expect(callsTo(fetchMock, LIST)).toBe(2));
  });

  test("ASSEMBLYAI_API_KEY is neither listed nor deletable", async () => {
    // It is seeded at publish from the caller's account key; deleting it takes
    // the agent off the air with nothing in this pane to restore it.
    stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ vars: ["ASSEMBLYAI_API_KEY", "OPENAI_API_KEY"] }),
    });
    renderPane();
    expect(await screen.findByText("OPENAI_API_KEY")).toBeInTheDocument();
    expect(screen.getAllByText("Delete")).toHaveLength(1);
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows.some((text) => text?.includes("ASSEMBLYAI_API_KEY"))).toBe(false);
  });

  test("a managed name typed into the pair is refused rather than saved and hidden", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ [`GET ${LIST}`]: () => jsonResponse({ vars: [] }) });
    renderPane();
    await waitFor(() => expect(callsTo(fetchMock, LIST)).toBe(1));
    await typePair(user, "ASSEMBLYAI_API_KEY", "leaked");
    fireEvent.click(screen.getByText("Add secret"));
    expect(screen.getByText(/managed for you and can't be set here/)).toBeInTheDocument();
    expect(fetchCallsWith(fetchMock, "PUT")).toHaveLength(0);
  });

  test("a managed key inside a paste is dropped and the rest still saves", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({
      [`GET ${LIST}`]: () => jsonResponse({ vars: [] }),
      [`PUT ${LIST}`]: () => jsonResponse({ vars: ["OPENAI_API_KEY"] }),
    });
    renderPane();
    await waitFor(() => expect(callsTo(fetchMock, LIST)).toBe(1));
    await pasteEnv(user, "ASSEMBLYAI_API_KEY=leaked\nOPENAI_API_KEY=ok");
    fireEvent.click(screen.getByText("Save secrets"));
    expect(await screen.findByText(/managed for you and can't be set here/)).toBeInTheDocument();
    const [put] = fetchCallsWith(fetchMock, "PUT");
    expect(put?.init.body).toContain("OPENAI_API_KEY");
    expect(put?.init.body).not.toContain("ASSEMBLYAI_API_KEY");
  });

  test("a paste of nothing but managed keys sends no request at all", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ [`GET ${LIST}`]: () => jsonResponse({ vars: [] }) });
    renderPane();
    await waitFor(() => expect(callsTo(fetchMock, LIST)).toBe(1));
    await pasteEnv(user, "ASSEMBLYAI_API_KEY=leaked");
    fireEvent.click(screen.getByText("Save secrets"));
    expect(screen.getByText(/managed for you and can't be set here/)).toBeInTheDocument();
    expect(callsTo(fetchMock, LIST)).toBe(1);
  });
});
