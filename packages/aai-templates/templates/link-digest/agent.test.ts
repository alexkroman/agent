// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the link digest — the workflow-app template.
 *
 * There are no tools to exercise, which is the point: what this template
 * demonstrates is a DECLARATION, so the spec asserts the declaration. Three
 * things carry the shape and each is silent when wrong — the `page: "static"`
 * field (without it the deployed agent still offers a `/websocket` nothing will
 * answer), the workflow's NAME (the page starts a run by that string, so a
 * rename here is a runtime 400 there), and the input schema (which is both the
 * call-site validation and the JSON Schema `GET /workflows` serves).
 *
 * The workflow BODY is not tested here: it is only durable once the Workflow
 * DevKit's build has transformed it, so a unit test of it would exercise a plain
 * async function and prove nothing about replay. Its STEPS are, and directly —
 * a step is an ordinary exported async function, so
 * async function, so its HTML handling, its JSON contract with the model and its
 * `FatalError` guards are all testable.
 */

import { createWorkflowCtx, schemaInputIssues } from "@alexkroman1/aai/testing";
import {
  installStubStepFetch,
  installStubGateway as stubGateway,
} from "@alexkroman1/aai/testing/vitest";
import { beforeEach, describe, expect, test, vi } from "vitest";
import agentDef, { digest } from "./agent.ts";
import {
  digestFlow,
  extractText,
  extractTitle,
  fetchArticle,
  summarize,
} from "./workflows/digest.ts";

describe("the agent declares itself a workflow app", () => {
  test("under the name the page starts a run by", () => {
    // `api.start("digest", …)` in client.tsx names this key. Nothing else
    // records it, so a rename here is a 400 there rather than a compile error.
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["digest"]);
    expect(agentDef.workflows?.digest).toBe(digest);
  });
});

describe("the input schema", () => {
  test("accepts a URL", async () => {
    // `schemaInputIssues` rather than `digest.input?.["~standard"].validate`:
    // the vendor interface is a wire contract, and `.validate` may answer
    // synchronously or with a promise depending on it — the half a hand-rolled
    // reach gets wrong, since a missing `await` leaves `.issues` undefined and
    // the refusing test below then passes for the wrong reason.
    expect(await schemaInputIssues(digest.input, { url: "https://example.com/a" })).toBeUndefined();
  });

  test("rejects a non-URL at the CALL SITE rather than three steps into a run", async () => {
    expect(await schemaInputIssues(digest.input, { url: "not a url" })).toBeDefined();
  });

  test("carries a description, which is what a rendered form labels the field with", () => {
    expect(digest.description).toBeTruthy();
    expect(digest.input).toBeDefined();
  });
});

describe("the agent declares the credential its steps read", () => {
  test("so a deploy checks for it rather than the first run", () => {
    // A workflow app declares no providers, so `requiredEnv` is the ONLY thing
    // in its config that can name a credential.
    expect(agentDef.requiredEnv).toContain("ASSEMBLYAI_API_KEY");
  });
});

describe("extractText", () => {
  test("drops script and style CONTENT, not just their tags", () => {
    // Stripping tags alone leaves a page's JavaScript in the prompt — expensive,
    // and a way to smuggle instructions past the reader.
    const text = extractText(
      "<html><head><style>body{color:red}</style></head><body><script>alert('x')</script><p>Real words here.</p></body></html>",
    );
    expect(text).toBe("Real words here.");
  });

  test("decodes &amp; LAST, so an escaped entity is not decoded twice", () => {
    // `&amp;lt;` is a literal `&lt;` on the page; decoding `&amp;` first would
    // turn it into a `<` the author never wrote.
    expect(extractText("<p>a &amp;lt; b &amp; c</p>")).toBe("a &lt; b & c");
  });

  test("collapses whitespace, because HTML indentation is not prose", () => {
    expect(extractText("<p>one</p>\n\n   <p>two</p>")).toBe("one two");
  });

  test("caps what crosses the queue to the next step", () => {
    const huge = `<p>${"word ".repeat(20_000)}</p>`;
    expect(extractText(huge).length).toBeLessThanOrEqual(24_000);
  });
});

describe("extractTitle", () => {
  test("reads the document title", () => {
    expect(extractTitle("<html><title>  Otters &amp; tools </title></html>")).toBe(
      "Otters & tools",
    );
  });

  test("answers undefined when there is none, so the caller can fall back", () => {
    expect(extractTitle("<html><body>hi</body></html>")).toBeUndefined();
  });
});

describe("fetchArticle", () => {
  /**
   * A page server answering `html` with `status`.
   *
   * Published into `stepFetch`'s own slot rather than over `globalThis.fetch`:
   * the step calls `stepFetch`, and stubbing the global would pass while
   * exercising the fallback path production never takes.
   *
   * `installStubStepFetch` unpublishes it on `onTestFinished`, which is why
   * there is no `afterEach` here — a fetch left behind reaches the next file,
   * and a hand-kept restore registry is the thing that forgets.
   */
  function stubPage(html: string, status = 200) {
    return installStubStepFetch(() => ({
      status,
      body: html,
      headers: { "Content-Type": "text/html" },
    }));
  }

  test("returns the page's title and its readable text", async () => {
    stubPage(
      `<html><title>Otters</title><body><p>${"Otters use tools. ".repeat(20)}</p></body></html>`,
    );
    const article = await fetchArticle("https://example.com/otters");
    expect(article.title).toBe("Otters");
    expect(article.text).toContain("Otters use tools.");
    expect(article.url).toBe("https://example.com/otters");
  });

  test("falls back to the hostname when the page has no title", async () => {
    stubPage(`<html><body><p>${"Otters use tools. ".repeat(20)}</p></body></html>`);
    expect((await fetchArticle("https://example.com/otters")).title).toBe("example.com");
  });

  test("fails FATALLY on a page with no readable text", async () => {
    // A JS-rendered site is the usual cause, and no number of attempts fixes it.
    stubPage("<html><body><div id='root'></div></body></html>");
    await expect(fetchArticle("https://example.com/app")).rejects.toThrow(/no readable text/);
  });

  test("fails FATALLY on a 404 and plainly on a 503", async () => {
    // `stepFetchOk` builds the message, so it is the SDK's one spelling for a
    // bad response — the REQUEST, the status, and a preview of any body.
    stubPage("", 404);
    await expect(fetchArticle("https://example.com/gone")).rejects.toThrow(
      /GET https:\/\/example\.com\/gone 404/,
    );
    stubPage("", 503);
    await expect(fetchArticle("https://example.com/gone")).rejects.toThrow(/503/);
  });
});

describe("summarize", () => {
  const ARTICLE = { url: "https://example.com/a", title: "Otters", text: "Otters use tools." };

  beforeEach(() => {
    // `stepEnv` falls back to the process env when no host has published one,
    // which is exactly the case a spec is. `unstubEnvs` clears it per test.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  test("returns the headline and points the model produced", async () => {
    const calls = stubGateway('{"headline":"Otters are clever","points":["a","b","c"]}');
    const result = await summarize(ARTICLE);

    expect(result).toEqual({
      url: ARTICLE.url,
      headline: "Otters are clever",
      points: ["a", "b", "c"],
    });
    // The key is a BEARER here — the gateway is OpenAI-compatible, unlike
    // AssemblyAI's streaming sockets, which take it raw.
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-test");
  });

  test("unwraps a fenced reply rather than failing on it", async () => {
    stubGateway('```json\n{"headline":"H","points":["a"]}\n```');
    expect((await summarize(ARTICLE)).headline).toBe("H");
  });

  test("throws PLAINLY when the model answered with prose, so the step retries", async () => {
    // The distinction that is the whole retry policy: a model that ignored the
    // format may well obey on the next attempt, where a 401 will not. Plain
    // means NOT a `FatalError`, which is what the DevKit stops retrying on.
    stubGateway("Here is a summary of the article about otters.");
    const err = await summarize(ARTICLE).catch((thrown: unknown) => thrown);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("FatalError");
    expect(err).toMatchObject({ message: expect.stringContaining("Expected JSON from the model") });
  });

  test("rejects JSON of the wrong shape as firmly as no JSON at all", async () => {
    // The reply parses and is an object, so only the SCHEMA catches it — which
    // is what taking a schema bought over the guard this used to hand-roll: the
    // failure NAMES the field that was missing.
    stubGateway('{"headline":"H"}');
    await expect(summarize(ARTICLE)).rejects.toThrow(/did not match the shape: points/);
  });

  test("fails FATALLY with no API key rather than retrying five times", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    stubGateway('{"headline":"H","points":["a"]}');
    await expect(summarize(ARTICLE)).rejects.toThrow(/ASSEMBLYAI_API_KEY/);
  });

  test("is called with more attempts than the default, because a rate limit and a bad format both happen", async () => {
    // The retry policy is an argument to `ctx.step` now, not a `maxRetries`
    // property on the function — so the assertion is about the BODY's call,
    // which is the only place the policy is observable at all. `runSteps: false`
    // because the subject is the declared policy rather than the work: the steps
    // would otherwise need a page and a model.
    const ctx = createWorkflowCtx({ runSteps: false });
    await digestFlow({ url: "https://example.com/a" }, ctx);

    const summarizeStep = ctx.steps.find((step) => step.name === "summarize");
    expect(summarizeStep?.maxAttempts).toBeGreaterThan(3);
    // The order is the body's, and it is worth pinning beside the policy: the
    // fetch is separate from the model call precisely so a rate-limited
    // summarize replays the fetch from the journal instead of hitting a
    // stranger's server again.
    expect(ctx.steps.map((step) => step.name)).toEqual(["fetchArticle", "summarize", "file"]);
  });
});
