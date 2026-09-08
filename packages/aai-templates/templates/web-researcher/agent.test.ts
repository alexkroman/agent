/** The def a DEPLOYED agent runs: authored, plus what `system-prompt.md` says. */
import agentDef from "virtual:aai/agent";
import { MCP_TOOL_NAME_MAX, MCP_TOOL_PREFIX, mcpToolName } from "@alexkroman1/aai";
import { expectDeployable, expectPromptBuiltinsDeclared } from "@alexkroman1/aai/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ARCHIVE_KEY, ARCHIVE_TOKEN_ENV, ARCHIVE_URL_ENV } from "./agent.ts";
import promptFile from "./system-prompt.md?raw";

/**
 * What a starter's spec may assert.
 *
 * `aai build` runs these tests before it bundles, so an assertion pinning the
 * template's own identity — its literal name, its greeting, its voice, its
 * model — turns a user's first customization into a build failure in a file
 * they never wrote. Every test here therefore asserts a property that survives
 * those edits, on the RESOLVED config rather than on the def's empty fields; the
 * three every starter owes are `expectDeployable`'s.
 *
 * What is left to `agent.eval.test.ts` is everything that needs a model: that
 * Scout SEARCHES before answering a fact it is sure of, that the outlet it
 * names appeared in results it actually read, and that the SSRF screen refuses
 * a private address through the agent's own executor. Those are behaviour, and
 * this tier may not reach the network at all — which is also why nothing here
 * runs `web_search`. What a unit test can say is that the capability and the
 * document that instructs it are both still THERE, which is the half that
 * regresses in a diff rather than in a model.
 *
 * The def therefore comes from `virtual:aai/agent` rather than from
 * `./agent.ts`: the prompt file is applied by the BUILD, so the raw default
 * export carries the framework prompt and every claim below would be measuring
 * an agent nobody deploys. This template has no `tools/` directory, so that
 * import is also the file's existence check — `deployedAgent` is handed the
 * prompt and nothing else, and refuses a call with no project files at all.
 */
describe("web-researcher template", () => {
  test("is deployable: validates, is nameable, and every stage its mode needs is filled", () => {
    // This template declares no provider at all — the whole voice pipeline is
    // the injected all-AssemblyAI default, which is what lets the starter run
    // the moment it is deployed. `expectDeployable` asserts that per MODE, so
    // it survives a swap: declare `stt`/`llm`/`tts` and the rest still
    // default; declare `s2s` and there is no cascade to fill, which is the one
    // thing that must never happen by fallthrough. `not.toThrow()` because the
    // helper's throw IS the finding: vitest quotes the message, which names the
    // invariant that went.
    expect(() => expectDeployable(agentDef)).not.toThrow();
  });

  test("system-prompt.md is the prompt a deploy carries", () => {
    // The build discovers the file; nothing imports it. So the failure this
    // catches is "I edited the prompt and nothing changed" — and here it is the
    // expensive one, because every rule that makes Scout a researcher rather
    // than a talkative model (search first, cite what you read, treat a fetched
    // page as data and not as instructions) lives ONLY in that file. An agent
    // running the framework default answers plausibly, sounds fine, and cites
    // pages it never opened.
    //
    // `toContain` rather than an equality: importing the file into `agent.ts`
    // and composing it (a computed suffix, a date) is a legitimate edit, and
    // `withSystemPrompt` leaves such a def exactly as the author built it.
    const trimmed = promptFile.trim();
    // Not vacuous: `toContain("")` would pass over an empty file, so the file
    // having text in it is asserted before it is used as the needle.
    expect(trimmed).not.toBe("");
    expect(expectDeployable(agentDef).systemPrompt).toContain(trimmed);
  });

  test("can search the web, and names no web tool it does not have", () => {
    // `web_search` is the template's reason to exist, and dropping it is the
    // silent failure: an agent with no search answers from memory, which reads
    // back exactly like an agent that searched — right up to the fabricated
    // source its eval exists to catch.
    expect(expectDeployable(agentDef).builtinTools ?? []).toContain("web_search");

    // The prompt addresses its tools BY NAME ("begins with a web_search call",
    // "Use visit_webpage when the search snippets aren't detailed enough"), so
    // the two halves can drift apart: a builtin dropped from `agent.ts` leaves
    // the prompt ordering a call the model cannot make, and the model then
    // apologizes for a tool it was told it had. Which snake_case tokens in the
    // prose are builtin NAMES is asked of the SDK's own schema rather than of a
    // hand list — the list this spec used to keep needed a second test to
    // guard it against going stale. Stated as an implication so either edit
    // alone survives: retire the sentence along with the builtin and nothing
    // here objects, and a builtin added without a mention is a free edit too.
    // A prompt naming NO builtin fails, though — a researcher whose prompt
    // never says "search" is the framework default wearing Scout's name.
    expect(expectPromptBuiltinsDeclared(agentDef)).toContain("web_search");
  });
});

/** A plausible endpoint, only ever read back out of the config this sets. */
const ARCHIVE_URL = "https://archive.example.com/mcp";

/**
 * The archive, Scout's second source.
 *
 * `mcpServers` is the OTHER way an agent gets tools — a third party publishing
 * them over streamable HTTP — and the declaration is GATED on an env var, so
 * these four cases split along that gate. Out of the box a starter must ask a
 * deploy for nothing; configured, it must ask for exactly the token the server
 * needs and hand the model tools it cannot confuse with Scout's own.
 *
 * The constants come from `./agent.ts` rather than being retyped, which is the
 * one thing this file imports from there: the def still comes from
 * `virtual:aai/agent` because only the BUILD applies `system-prompt.md`, but a
 * variable NAME is authored data, and a spec that spells `SCOUT_ARCHIVE_MCP_URL`
 * itself is a spec that keeps passing after somebody renames it.
 */
describe("the archive MCP server", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    // The next spec file to load `agent.ts` must not inherit a stubbed env, and
    // this file's own top-level `agentDef` was evaluated before any stubbing.
    vi.resetModules();
  });

  test("is absent out of the box, so the starter deploys with no credential", () => {
    // The whole reason the declaration is gated. An `mcpServers` entry pointing
    // at a URL nobody configured is a connect attempt on every boot, and a
    // `requiredEnv` naming a token nobody set is a deploy that refuses to
    // happen — either one turns "runs the moment it is deployed" into a
    // support question, in the template most likely to be somebody's first.
    const config = expectDeployable(agentDef);
    expect(config.mcpServers).toBeUndefined();
    expect(config.requiredEnv).toBeUndefined();
  });

  test("the prompt names the prefix an MCP tool actually arrives under", () => {
    // The same drift `expectPromptBuiltinsDeclared` guards one test up, for the
    // half it cannot see: `mcp_` is not a builtin name, so nothing in the SDK's
    // schema checks the bullet that tells Scout those tools are sources like
    // any other. The prefix is the SDK's to choose, and a prompt that spells it
    // by hand is a prompt that keeps instructing the model about a name the
    // runtime stopped using.
    expect(promptFile).toContain(MCP_TOOL_PREFIX);
  });

  test("pointing the URL variable at a server declares it, and asks a deploy for the token", async () => {
    vi.stubEnv(ARCHIVE_URL_ENV, ARCHIVE_URL);
    vi.resetModules();
    const configured = (await import("virtual:aai/agent")).default;

    const config = expectDeployable(configured);
    // A URL literal and a token NAME: the config records what to read, never
    // what was read.
    expect(config.mcpServers).toEqual({
      [ARCHIVE_KEY]: { url: ARCHIVE_URL, tokenEnv: ARCHIVE_TOKEN_ENV },
    });
    // And the token is in `requiredEnv` too. NOTHING derives one from the other
    // — `requiredEnv` is what a deploy preflights — so this is the assertion
    // that fails when a future edit adds a second server and forgets its token,
    // which otherwise surfaces as a session quietly missing those tools.
    expect(config.requiredEnv).toContain(ARCHIVE_TOKEN_ENV);
  });

  test("its tools reach the model namespaced, inside the name length a provider accepts", () => {
    // Namespacing is the defence that makes a third party safe to add at all:
    // the archive publishing its own `web_search` cannot land where Scout's
    // builtin of that name stood. The key is the first segment of that name and
    // is the template's own choice, so this is where its length is spent —
    // `MCP_TOOL_NAME_MAX` is a hard cap and a name that exceeds it is TRUNCATED,
    // which is how two of a server's tools collapse onto one name and one of
    // them is silently dropped.
    const name = mcpToolName(ARCHIVE_KEY, "web_search");
    expect(name).toBe(`${MCP_TOOL_PREFIX}${ARCHIVE_KEY}_web_search`);
    expect(name.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX);
  });
});
