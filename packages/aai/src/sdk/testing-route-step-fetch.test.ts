// Copyright 2026 the AAI authors. MIT license.
/**
 * `routeStepFetch` — the composition thirteen template sites wrote by hand.
 *
 * The subject is the UNMATCHED policy, because that is the half the thirteen
 * disagreed on and the half whose wrong answer hides a finding rather than
 * showing one.
 */
import { describe, expect, test } from "vitest";
import { routeStepFetch, type StepRoute, type StubStepRequest } from "./testing.ts";

const ask = (url: string, method = "GET"): StubStepRequest => ({
  url,
  method,
  headers: {},
  body: undefined,
});

/** A leg that answers one host and declines everything else. */
const legFor =
  (host: string, body: unknown): StepRoute =>
  (request) =>
    request.url.startsWith(host) ? { body } : undefined;

describe("routeStepFetch", () => {
  test("the first leg to answer wins, and later legs are not consulted", () => {
    const seen: string[] = [];
    const first: StepRoute = (r) => {
      seen.push("first");
      return r.url.includes("model") ? { body: "m" } : undefined;
    };
    const second: StepRoute = () => {
      seen.push("second");
      return { body: "s" };
    };
    const handler = routeStepFetch([first, second]);

    expect(handler(ask("https://x.test/model"))).toEqual({ body: "m" });
    expect(seen).toEqual(["first"]);
  });

  test("an unmatched request THROWS by default, naming the method and URL", () => {
    const handler = routeStepFetch([legFor("https://a.test", "a")]);
    // The default is the strict one on purpose: the alternatives turn "the spec
    // forgot a leg" into a run taking its own error path and passing green.
    expect(() => handler(ask("https://b.test/thing", "POST"))).toThrow(
      /no step route for POST https:\/\/b\.test\/thing/,
    );
  });

  test("`notFound` answers a real 404 for a spec whose subject IS one", () => {
    const handler = routeStepFetch([legFor("https://a.test", "a")], { unmatched: "notFound" });
    expect(handler(ask("https://b.test/thing"))).toMatchObject({ status: 404 });
  });

  test("a fallback ROUTE catches everything the named legs declined", () => {
    const handler = routeStepFetch([legFor("https://model.test", "m")], {
      unmatched: () => ({ body: "<p>page</p>" }),
    });
    expect(handler(ask("https://model.test/v1"))).toEqual({ body: "m" });
    expect(handler(ask("https://anywhere.test/article"))).toEqual({ body: "<p>page</p>" });
  });

  test("a fallback that itself declines is the same finding as having none", () => {
    // `undefined` is not a legal answer for the handler `stubStepFetch` installs,
    // so silently encoding it would produce an empty 200 — a provider that said
    // nothing, which is the shape hardest to debug.
    const handler = routeStepFetch([], { unmatched: () => undefined });
    expect(() => handler(ask("https://b.test/x"))).toThrow(/fallback step route declined/);
  });

  test("no legs at all still throws rather than answering nothing", () => {
    expect(() => routeStepFetch([])(ask("https://b.test/x"))).toThrow(/no step route/);
  });

  test("a leg may answer a whole Response, which passes through untouched", () => {
    const response = new Response("raw", { status: 201 });
    const handler = routeStepFetch([() => response]);
    expect(handler(ask("https://a.test"))).toBe(response);
  });
});
