// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The "Sync to GitHub" card: the three states, and which one the SERVER puts
// the card in.
//
// The state the suite cares about most is the first: a platform with no GitHub
// App must render NOTHING. That is what keeps the Settings pane of a
// self-hosted deploy exactly as it was, and it is invisible in a diff — a card
// that renders an explanatory row instead would still look correct here.

import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  button,
  fetchCall,
  input,
  jsonResponse,
  renderWithClient,
  stubFetch,
} from "./_test-utils.ts";
import {
  GithubCard,
  type GithubSyncState,
  lastCommitUrl,
  pickerOrder,
  syncStateText,
} from "./github-card.tsx";
import { consumeGithubResult, githubResultText } from "./github-result.ts";

const CONNECTED = {
  configured: true,
  connected: true,
  account: "acme",
  accountType: "Organization",
  manageUrl: "https://github.com/apps/aai-studio/installations/new",
};

const REPOS = { repos: [{ fullName: "acme/voice-agent", private: true }] };

function renderCard(data?: GithubSyncState) {
  renderWithClient(<GithubCard bearer="tok" project="demo" data={data} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("pickerOrder", () => {
  test("puts the newest installation entry first and copies the array", () => {
    // GitHub lists an installation's repositories oldest-first, so the one a
    // user just created to sync into — the only entry they are certain of —
    // was last in a list that runs to a thousand.
    const repos = [
      { fullName: "acme/oldest", private: false },
      { fullName: "acme/newest", private: true },
    ];
    expect(pickerOrder(repos).map((entry) => entry.fullName)).toEqual([
      "acme/newest",
      "acme/oldest",
    ]);
    // Copied, not reversed in place: the array belongs to the query cache, and
    // reversing it there would flip the order again on every re-render.
    expect(repos.map((entry) => entry.fullName)).toEqual(["acme/oldest", "acme/newest"]);
  });
});

describe("syncStateText", () => {
  test("distinguishes never-synced, current, and behind", () => {
    // Three states one word apart, which is why they are a pure function
    // rather than nested ternaries inside the render.
    expect(syncStateText(undefined)).toBeNull();
    expect(syncStateText({})).toBeNull();
    expect(syncStateText({ githubRepo: "a/b", githubStale: false })).toContain("up to date");
    expect(syncStateText({ githubRepo: "a/b", githubStale: true })).toContain(
      "edits GitHub does not have",
    );
  });
});

describe("lastCommitUrl", () => {
  test("builds the commit link from the workspace stamps", () => {
    // What makes `githubCommit` a stamp anything READS: the sync response's
    // own link is gone after a reload, and "where did this last go" is exactly
    // the question a cold open asks.
    expect(lastCommitUrl({ githubRepo: "acme/app", githubCommit: "c0ffee" })).toBe(
      "https://github.com/acme/app/commit/c0ffee",
    );
  });

  test("is null until BOTH stamps exist", () => {
    // Half a stamp builds a URL that 404s, which is worse than no link.
    expect(lastCommitUrl(undefined)).toBeNull();
    expect(lastCommitUrl({})).toBeNull();
    expect(lastCommitUrl({ githubRepo: "acme/app" })).toBeNull();
    expect(lastCommitUrl({ githubCommit: "c0ffee" })).toBeNull();
  });
});

describe("GithubCard", () => {
  test("renders NOTHING when the platform has no GitHub App", async () => {
    // A self-hosted deploy has no App, and a permanent card about a feature
    // the reader cannot obtain is worse than no card.
    stubFetch({ "/studio/github": () => jsonResponse({ configured: false, connected: false }) });
    renderCard();
    await waitFor(() => {
      expect(screen.queryByText("Sync to GitHub")).toBeNull();
    });
  });

  test("renders nothing while the status is still in flight", () => {
    // Held back rather than defaulted, so the card never appears and vanishes.
    stubFetch({ "/studio/github": () => jsonResponse({ configured: true, connected: false }) });
    renderCard();
    expect(screen.queryByText("Sync to GitHub")).toBeNull();
  });

  test("configured but not connected offers exactly one button", async () => {
    stubFetch({ "/studio/github": () => jsonResponse({ configured: true, connected: false }) });
    renderCard();
    await screen.findByText("Sync to GitHub");
    expect(button(/Connect GitHub/)).toBeTruthy();
    // No picker before there is an installation to pick from.
    expect(screen.queryByText("Repository")).toBeNull();
  });

  test("Connect navigates the tab to the URL the server minted", async () => {
    // A full navigation and not a popup: the install flow is several GitHub
    // pages ending in a redirect back here, which a popup would strand.
    const mock = stubFetch({
      "/studio/github": () => jsonResponse({ configured: true, connected: false }),
      "POST /studio/github/connect": () =>
        jsonResponse({ installUrl: "https://github.com/apps/aai-studio/installations/new" }),
    });
    // A getter/setter pair over a local, rather than spreading
    // `window.location`: Location's properties live on its prototype, so a
    // spread yields `{}` and every later `new URL(window.location.href)` —
    // `consumeGithubResult`'s included — throws `Invalid URL`.
    let href = "http://localhost/";
    vi.stubGlobal("location", {
      get href() {
        return href;
      },
      set href(value: string) {
        href = value;
      },
    });

    renderCard();
    await screen.findByText("Sync to GitHub");
    fireEvent.click(button(/Connect GitHub/));

    await waitFor(() => {
      expect(href).toBe("https://github.com/apps/aai-studio/installations/new");
    });
    // The project rides along so the callback returns the user here.
    const connectCall = mock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(connectCall?.[1]?.body))).toEqual({ project: "demo" });
  });

  test("connected lists the repositories and names the account", async () => {
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
    });
    renderCard();

    await screen.findByText("acme");
    await screen.findByText("acme/voice-agent (private)");
    expect(screen.getByText("Add or remove repositories")).toBeTruthy();
  });

  test("the picker renders the newest repository first", async () => {
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () =>
        jsonResponse({
          repos: [
            { fullName: "acme/oldest", private: false },
            { fullName: "acme/newest", private: true },
          ],
        }),
    });
    renderCard();

    await screen.findByText("acme/newest (private)");
    // The rendered order, not just the helper's: the picker is where this is
    // either true or invisible.
    expect([...document.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Choose a repository…",
      "acme/newest (private)",
      "acme/oldest",
    ]);
  });

  test("an installation with no repositories says where the fix is", async () => {
    // The state a user is most likely to be stuck in, and the fix is on
    // GitHub — so it must not read as a list that never finished loading.
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse({ repos: [] }),
    });
    renderCard();
    expect(await screen.findByText(/cannot write to any repository yet/)).toBeTruthy();
  });

  test("Sync is disabled until a repository is chosen", async () => {
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
    });
    renderCard();
    await screen.findByText("acme/voice-agent (private)");
    expect(button(/Sync to GitHub/).disabled).toBe(true);
  });

  test("the picker defaults to where the project last synced", async () => {
    // The common case is pressing Sync again after an edit, which should need
    // no selection at all.
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
    });
    renderCard({ githubRepo: "acme/voice-agent", githubStale: true });

    await screen.findByText("acme/voice-agent (private)");
    expect(button(/Sync to GitHub/).disabled).toBe(false);
    await screen.findByText(/edits GitHub does not have yet/);
  });

  test("a sync reports where it landed and links the commit", async () => {
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
      "POST /studio/projects/demo/github/sync": () =>
        jsonResponse({
          ok: true,
          repo: "acme/voice-agent",
          branch: "main",
          changed: true,
          commitSha: "c0ffee",
          commitUrl: "https://github.com/acme/voice-agent/commit/c0ffee",
          syncedHash: "h",
        }),
    });
    renderCard({ githubRepo: "acme/voice-agent", githubStale: true });

    await screen.findByText("acme/voice-agent (private)");
    fireEvent.click(button(/Sync to GitHub/));

    await screen.findByText(/Pushed to/);
    const link = screen.getByText("View commit");
    expect(link.getAttribute("href")).toBe("https://github.com/acme/voice-agent/commit/c0ffee");
  });

  test("a no-op sync says so rather than claiming a push", async () => {
    // `changed: false` is the second click with no edits between, and the
    // stamps alone cannot tell it from a push — only the response can.
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
      "POST /studio/projects/demo/github/sync": () =>
        jsonResponse({
          ok: true,
          repo: "acme/voice-agent",
          branch: "main",
          changed: false,
          commitSha: "abc",
          commitUrl: "https://github.com/acme/voice-agent/commit/abc",
          syncedHash: "h",
        }),
    });
    renderCard({ githubRepo: "acme/voice-agent", githubStale: false });

    await screen.findByText("acme/voice-agent (private)");
    fireEvent.click(button(/Sync to GitHub/));
    expect(await screen.findByText(/Already up to date on/)).toBeTruthy();
  });

  test("a cold open links the LAST synced commit from the workspace stamps", async () => {
    // No sync this session, so the response-carried link does not exist — the
    // stamp is the only thing that can answer where the project last went.
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
    });
    renderCard({ githubRepo: "acme/voice-agent", githubCommit: "abc123", githubStale: false });

    const link = await screen.findByText("View last commit");
    expect(link.getAttribute("href")).toBe("https://github.com/acme/voice-agent/commit/abc123");
  });

  test("a failed sync shows the server's own sentence", async () => {
    // The server's message names the FIX ("Grant it Contents: read and
    // write"), so flattening it into a generic failure loses the whole value.
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
      "POST /studio/projects/demo/github/sync": () =>
        jsonResponse({ error: "Grant it Contents: read and write." }, 502),
    });
    renderCard({ githubRepo: "acme/voice-agent", githubStale: true });

    await screen.findByText("acme/voice-agent (private)");
    fireEvent.click(button(/Sync to GitHub/));
    expect(await screen.findByText("Grant it Contents: read and write.")).toBeTruthy();
  });

  test("an organization is offered repository creation; a personal account is not", async () => {
    // Absent rather than disabled: GitHub does not permit an App to create a
    // repository in a personal account at all, so a greyed-out field would
    // promise something no permission grant can unlock.
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
    });
    renderCard();
    expect(await screen.findByText("Or create a new one")).toBeTruthy();
    cleanup();

    stubFetch({
      "/studio/github": () => jsonResponse({ ...CONNECTED, accountType: "User" }),
      "/studio/github/repos": () => jsonResponse(REPOS),
    });
    renderCard();
    await screen.findByText("acme/voice-agent (private)");
    expect(screen.queryByText("Or create a new one")).toBeNull();
  });

  test("creating a repository selects it, so Sync is immediately usable", async () => {
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
      "POST /studio/github/repos": () =>
        jsonResponse({ repo: { fullName: "acme/fresh", private: true } }),
    });
    renderCard();
    await screen.findByText("Or create a new one");

    fireEvent.change(input("Or create a new one"), { target: { value: "fresh" } });
    fireEvent.click(button(/^Create$/));

    // Selected on success — the user named it in order to push to it.
    await waitFor(() => {
      expect(button(/Sync to GitHub/).disabled).toBe(false);
    });
  });

  test("Disconnect asks first, and a refusal makes no request", async () => {
    const mock = stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
    });
    renderCard();
    await screen.findByText("acme/voice-agent (private)");

    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    fireEvent.click(button(/Disconnect/));
    expect(mock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  test("the install callback's result is shown once and stripped from the URL", async () => {
    // The parameter must not survive: the studio pushes and pops history, so
    // a surviving one re-announces the connection on every visit back.
    window.history.replaceState(null, "", "/studio/chat/demo?github=connected");
    stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
    });
    renderCard();

    await screen.findByText("GitHub connected.");
    expect(window.location.search).toBe("");
  });

  test("the status read carries the session bearer", async () => {
    const mock = stubFetch({
      "/studio/github": () => jsonResponse(CONNECTED),
      "/studio/github/repos": () => jsonResponse(REPOS),
    });
    renderCard();
    await screen.findByText("acme/voice-agent (private)");
    const headers = fetchCall(mock).init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });
});

describe("consumeGithubResult", () => {
  test("reads a known result once and removes the parameter", () => {
    window.history.replaceState(null, "", "/?github=connected&keep=1");
    expect(consumeGithubResult()).toBe("connected");
    // Everything else in the URL survives — this strips one parameter, not
    // the query.
    expect(window.location.search).toBe("?keep=1");
    expect(consumeGithubResult()).toBeNull();
  });

  test("an unknown value is dropped rather than shown", () => {
    // The parameter is user-editable and the card renders our own sentence per
    // outcome, so reflecting an unknown one would be a way to put arbitrary
    // text on the page.
    window.history.replaceState(null, "", "/?github=<script>");
    expect(consumeGithubResult()).toBeNull();
    expect(window.location.search).toBe("");
  });

  test("no parameter at all is null and leaves the URL alone", () => {
    window.history.replaceState(null, "", "/studio/chat/demo");
    expect(consumeGithubResult()).toBeNull();
    expect(window.location.pathname).toBe("/studio/chat/demo");
  });
});

describe("githubResultText", () => {
  test("each outcome names what to do about it", () => {
    expect(githubResultText("connected")).toContain("connected");
    expect(githubResultText("expired")).toContain("try connecting again");
    expect(githubResultText("unverified")).toContain("administer");
    expect(githubResultText("unconfigured")).toContain("not configured");
    expect(githubResultText("failed")).toContain("try again");
  });
});
