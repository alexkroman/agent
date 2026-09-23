// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The one-shot `?github=` report: peeked without consuming, consumed exactly
// once and stripped by `replaceState`, and an unknown value dropped rather than
// reflected onto the page.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  consumeGithubResult,
  type GithubConnectResult,
  githubResultText,
  hasGithubResult,
} from "./github-result.ts";

let original: string;

beforeEach(() => {
  original = window.location.href;
});

afterEach(() => {
  history.replaceState(null, "", original);
  vi.restoreAllMocks();
});

function land(search: string) {
  history.replaceState({ from: "test" }, "", `/studio/projects/demo${search}`);
}

describe("hasGithubResult", () => {
  test("peeks without consuming", () => {
    land("?github=connected");
    expect(hasGithubResult()).toBe(true);
    expect(hasGithubResult()).toBe(true);
    expect(window.location.search).toBe("?github=connected");
  });

  test("false when the parameter is absent", () => {
    land("?tab=settings");
    expect(hasGithubResult()).toBe(false);
  });

  test("true even for a value consume would drop — the pane still has to open", () => {
    land("?github=");
    expect(hasGithubResult()).toBe(true);
  });
});

describe("consumeGithubResult", () => {
  test.each<GithubConnectResult>(["connected", "failed", "expired", "unverified", "unconfigured"])(
    "reads %s once, then it is gone",
    (result) => {
      land(`?github=${result}`);
      expect(consumeGithubResult()).toBe(result);
      expect(consumeGithubResult()).toBeNull();
      expect(hasGithubResult()).toBe(false);
    },
  );

  test("strips only its own parameter, keeping the path, others, hash and history state", () => {
    land("?tab=settings&github=connected&x=1#frag");
    consumeGithubResult();
    expect(window.location.pathname).toBe("/studio/projects/demo");
    expect(window.location.search).toBe("?tab=settings&x=1");
    expect(window.location.hash).toBe("#frag");
    expect(history.state).toEqual({ from: "test" });
  });

  test("REPLACES the entry rather than pushing one, so Back does not re-announce", () => {
    land("?github=connected");
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    const length = history.length;
    consumeGithubResult();
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(history.length).toBe(length);
  });

  test("an unrecognized value is dropped AND stripped", () => {
    land("?github=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    expect(consumeGithubResult()).toBeNull();
    expect(hasGithubResult()).toBe(false);
  });

  test("absent parameter: null, and the URL is untouched", () => {
    land("?tab=settings");
    const replace = vi.spyOn(history, "replaceState");
    expect(consumeGithubResult()).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?tab=settings");
  });
});

describe("githubResultText", () => {
  test("every outcome has its own sentence", () => {
    const results: GithubConnectResult[] = [
      "connected",
      "failed",
      "expired",
      "unverified",
      "unconfigured",
    ];
    const texts = results.map(githubResultText);
    expect(new Set(texts).size).toBe(results.length);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
  });

  test("connected is the success sentence; failures say what to do next", () => {
    expect(githubResultText("connected")).toBe("GitHub connected.");
    expect(githubResultText("failed")).toMatch(/try again/);
    expect(githubResultText("expired")).toMatch(/expired/);
    expect(githubResultText("unverified")).toMatch(/administer/);
    expect(githubResultText("unconfigured")).toMatch(/not configured/);
  });
});
