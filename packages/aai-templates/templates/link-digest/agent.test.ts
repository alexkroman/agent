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
 * The STEPS are exercised directly — a step is an ordinary exported async
 * function, so its HTML handling, its JSON contract with the model and its
 * `FatalError` guards are all testable without an engine.
 *
 * And so is the BODY, durably, which it was not: this file used to say the body
 * "is only durable once the Workflow DevKit's build has transformed it, so a
 * unit test of it would exercise a plain async function and prove nothing about
 * replay". That stopped being true when the DevKit was replaced — the engine
 * runs a run off the agent's own `workflows` declaration, in process, with no
 * bundler in the path. `runWorkflow` from `@alexkroman1/aai-runtime/testing` is
 * that engine, so the last block below asserts the thing this template exists to
 * demonstrate: the run SUSPENDS on its settle window and resumes past it without
 * fetching the page or paying the model again.
 */

import {
  createWorkflowContext,
  schemaInputIssues,
  stubGatewayRoute,
  stubStepInfo,
} from "@alexkroman1/aai/testing";
import {
  installStubStepFetch,
  installStubGateway as stubGateway,
} from "@alexkroman1/aai/testing/vitest";
import {
  type RunWorkflowOptions,
  runWorkflow,
  type WorkflowTestStep,
} from "@alexkroman1/aai-runtime/testing";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import agentDef, { digest } from "./agent.ts";
import {
  articlePrompt,
  digestFlow,
  extractMetadata,
  extractText,
  fetchArticle,
  SETTLE_MS,
  summarize,
} from "./workflows/digest.ts";

describe("the agent declares itself a workflow app", () => {
  test("under the name the page starts a run by", () => {
    // `api.start("digest", …)` in client.tsx names this key. Nothing else
    // records it, so a rename here is a 400 there rather than a compile error.
    // `toContain` rather than an exact key list: adding a second workflow is an
    // invited edit and must not redden a test the author did not write. The
    // NAME is still pinned, deliberately — the page starts a run by this
    // string, so renaming the key is a runtime 400 rather than a compile
    // error, and this pin is the only thing that says so. Rename it here and
    // in `client.tsx` together.
    expect(Object.keys(agentDef.workflows ?? {})).toContain("digest");
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

describe("extractMetadata", () => {
  test("reads the document title", () => {
    expect(extractMetadata("<html><title>  Otters &amp; tools </title></html>").title).toBe(
      "Otters & tools",
    );
  });

  test("answers undefined when there is none, so the caller can fall back", () => {
    expect(extractMetadata("<html><body>hi</body></html>").title).toBeUndefined();
  });

  test("reads the page's own summary, preferring what OpenGraph declares", () => {
    // `pageMetadata` is the SDK's reader and this template's whole use of it —
    // `og:description` over the bare meta tag, the same precedence it applies
    // to the title.
    const html = `<html><head>
      <meta name="description" content="A stub for search engines.">
      <meta property="og:description" content="How sea otters
        use stones as anvils.">
    </head></html>`;
    expect(extractMetadata(html).description).toBe("How sea otters use stones as anvils.");
  });

  test("answers undefined for a page that describes itself with whitespace", () => {
    // The `|| undefined` rather than `?? undefined`: a head field indented onto
    // its own line collapses to `""`, and an empty summary in the prompt is
    // worse than none — see `articlePrompt`.
    expect(
      extractMetadata('<html><head><meta name="description" content="  ">').description,
    ).toBeUndefined();
  });
});

describe("articlePrompt", () => {
  const ARTICLE = { url: "https://example.com/a", title: "Otters", text: "Otters use tools." };

  test("labels the page's own summary rather than pasting it in front of the text", () => {
    const prompt = articlePrompt({ ...ARTICLE, description: "Otters are clever." });
    expect(prompt).toContain("The page's own summary: Otters are clever.");
    // The body still arrives last and whole; the abstract is context, not a
    // replacement for what the page said.
    expect(prompt.endsWith("Otters use tools.")).toBe(true);
  });

  test("omits the label entirely when the page declares no summary", () => {
    // A bare `Summary:` reads to a model as an empty summary rather than an
    // absent one, which is the only reason this is a branch at all.
    expect(articlePrompt(ARTICLE)).not.toContain("own summary");
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

  test("carries the page's own summary across the queue, and omits the key when there is none", async () => {
    // The property that makes it safe to put on a step RESULT: an absent
    // description is an absent KEY, not a `"description": undefined` the JSON
    // between the two steps has no way to spell.
    stubPage(
      `<html><head><title>Otters</title>
      <meta property="og:description" content="Otters use stones as anvils."></head>
      <body><p>${"Otters use tools. ".repeat(20)}</p></body></html>`,
    );
    expect((await fetchArticle("https://example.com/otters")).description).toBe(
      "Otters use stones as anvils.",
    );

    stubPage(
      `<html><title>Otters</title><body><p>${"Otters use tools. ".repeat(20)}</p></body></html>`,
    );
    expect(await fetchArticle("https://example.com/otters")).not.toHaveProperty("description");
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
    // `stepFetchOrFail` builds the message, so it is the SDK's one spelling for a
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

  test("asks for something simpler on the LAST attempt, not on the first", async () => {
    // The branch the extra attempts exist for, and it is only reachable from a
    // spec through `stubStepInfo`: outside a run `stepInfo()` answers
    // `undefined`, which the step reads as the ordinary path. Five attempts of
    // the same ask having failed, the sixth changes the ask.
    onTestFinished(stubStepInfo({ attempt: 6, maxAttempts: 6 }).restore);
    const calls = stubGateway('{"headline":"H","points":["a","b","c"]}');

    await summarize(ARTICLE);

    expect(calls[0]?.system).toContain("one short sentence");
  });

  test("asks the ordinary way when the attempt is not the last", async () => {
    // The half that makes the case above mean something: a spec that only
    // asserted the fallback would pass against a step that always degraded.
    onTestFinished(stubStepInfo({ attempt: 1, maxAttempts: 6 }).restore);
    const calls = stubGateway('{"headline":"H","points":["a","b","c"]}');

    await summarize(ARTICLE);

    expect(calls[0]?.system).not.toContain("one short sentence");
  });

  test("is called with more attempts than the default, because a rate limit and a bad format both happen", async () => {
    // The retry policy is an argument to `ctx.step` now, not a `maxRetries`
    // property on the function — so the assertion is about the BODY's call,
    // which is the only place the policy is observable at all. `runSteps: false`
    // because the subject is the declared policy rather than the work: the steps
    // would otherwise need a page and a model.
    const ctx = createWorkflowContext({ runSteps: false });
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

/**
 * The run itself, against a real durable engine.
 *
 * `runWorkflow` starts the declared workflow on
 * `createInProcessWorkflowEngine` over a memory journal — the same composition
 * root `aai dev` uses — and supplies what a deployment's queue supplies: one
 * delivery at a time, and a suspension recorded rather than waited out. So a
 * `ctx.sleep` a deployed run would take ten seconds over (or six hours, which
 * the body's own comment says is the interesting version) costs this file
 * nothing, and what is asserted is the property the template is FOR.
 *
 * The steps are stubbed at the same two seams the blocks above use, which is
 * what makes this affordable: the body is real, the engine is real, the journal
 * is real, and only the page and the model are not.
 */
describe("the run is DURABLE", () => {
  const PAGE = `<html><title>Otters</title><body><p>${"Otters use tools. ".repeat(20)}</p></body></html>`;
  const REPLY = '{"headline":"Otters use tools","points":["They do."]}';

  beforeEach(() => {
    // The same fallback the `summarize` block above relies on: `stepEnv` reads
    // the process env when no host has published one, which is what a spec is.
    // A run whose step cannot read its credential fails FATALLY and the whole
    // durability claim would be made about a run that never got past its first
    // model call.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  /**
   * The page and the model, behind ONE published `stepFetch`.
   *
   * The composition `stubGatewayRoute` exists for, and the reason it has to be
   * this way here rather than `installStubGateway` beside a page stub: a step's
   * HTTP — the model call included — goes through the published slot, so a page
   * stub installed alongside answers the gateway request with HTML and the
   * summarize step retries six times against it. The blocks above never hit
   * that because each stubs one seam at a time.
   *
   * Both call logs come back, which is what makes a replay countable.
   */
  function stubWorld(replies: string | readonly string[] = REPLY) {
    const model = stubGatewayRoute(replies);
    const page = vi.fn(() => ({
      status: 200,
      body: PAGE,
      headers: { "Content-Type": "text/html" },
    }));
    installStubStepFetch((request) => model.route(request) ?? page());
    return { page, model: model.calls };
  }

  /**
   * Start the declared digest on the engine, with whatever the case needs of
   * the driver.
   *
   * `RunWorkflowOptions` rather than an inline shape: `name` is the journal's
   * key for this workflow and belongs in ONE place, and the annotation is what
   * lets a case add `crashAt` without restating it.
   */
  function start(options?: RunWorkflowOptions) {
    return runWorkflow(
      digest,
      { url: "https://example.com/otters" },
      { name: "digest", ...options },
    );
  }

  /** One journal entry, by NAME — the position of a step in the list is not one. */
  function stepNamed(
    steps: readonly WorkflowTestStep[],
    name: string,
  ): WorkflowTestStep | undefined {
    return steps.find((step) => step.name === name);
  }

  test("suspends on the settle window instead of blocking, with its work already journaled", async () => {
    stubWorld();
    const started = Date.now();
    const run = await start();

    // `running` is the PARKED state — the run is in progress, it is just not
    // executing, which is what a page polling it sees.
    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeGreaterThanOrEqual(started + SETTLE_MS);
    // Everything BEFORE the wait is already durable, and `file` has not run.
    expect(run.steps.map((step) => step.name)).toEqual(["fetchArticle", "summarize"]);
  });

  test("resumes past the wait without re-reading the page or paying the model again", async () => {
    const { page, model } = stubWorld();
    const run = await start();
    await run.advanceSleep();

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ headline: "Otters use tools", points: ["They do."] });
    expect(run.output?.filedAt).toBeTruthy();
    // Two walks of the body, one fetch and one completion. That is the whole
    // durable-execution claim, and it is why the body splits the fetch from the
    // model call: a resume replays a stranger's page out of the journal rather
    // than requesting it again.
    expect(run.deliveries).toBe(2);
    expect(page).toHaveBeenCalledTimes(1);
    expect(model).toHaveLength(1);
  });

  test("survives a worker that dies mid-run, and only re-runs what never settled", async () => {
    const { page, model } = stubWorld();
    // Killed on the way into `summarize`: the fetch is journaled, the model call
    // is not. This is the failure a body cannot be written against without being
    // able to produce it.
    const run = await start({ crashAt: "summarize" });
    expect(run.crashed).toBe(true);
    expect(run.steps.map((step) => step.name)).toEqual(["fetchArticle"]);
    expect(model).toHaveLength(0);

    await run.restart();
    await run.advanceSleep();
    expect(run.status).toBe("completed");
    expect(page).toHaveBeenCalledTimes(1);
    expect(model).toHaveLength(1);
  });

  test("retries the model in place when it answers with prose, and does NOT read the page again", async () => {
    // What `maxAttempts: 6` at the `ctx.step` call site actually buys, asserted
    // against the engine rather than against the declaration. The `summarize`
    // block above proves the step THROWS plainly on prose; only a real journal
    // can show that the throw is retried, that the retry is charged to that step
    // alone, and that the expensive-to-a-stranger half is replayed rather than
    // re-issued. A first draft asserts `run.status` and misses all three.
    const { page, model } = stubWorld(["Here is a summary of the article about otters.", REPLY]);
    const run = await start();
    await run.advanceSleep();

    expect(run.status).toBe("completed");
    expect(model).toHaveLength(2);
    // Two attempts against ONE journal entry — a retry is not a second step, so
    // `attempts` is the only place it shows.
    expect(stepNamed(run.steps, "summarize")?.attempts).toBe(2);
    // And the retry stayed inside the step it belongs to: the body is not
    // re-walked from the top, so a stranger's server sees one request however
    // many times the model has to be asked.
    expect(stepNamed(run.steps, "fetchArticle")?.attempts).toBe(1);
    expect(page).toHaveBeenCalledTimes(1);
  });
});
