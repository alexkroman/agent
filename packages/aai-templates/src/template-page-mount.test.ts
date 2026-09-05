// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Every template declares its front door consistently at BOTH ends: the helper
 * its `agent.ts` calls, and the mount its `client.tsx` uses.
 *
 * There are two of each and the agent's own `page` field decides which. A VOICE
 * agent is declared with `agent()` and mounts with `mountClient()`, which
 * builds a `BrowserSession` — a WebSocket URL provider, an audio graph and a
 * microphone request. A WORKFLOW APP (`page: "static"`) is declared with
 * `workflowApp()` and mounts with `mountPage()`, which builds none of them.
 *
 * **konsistent cannot express either half**, which is why both checks live
 * here. `agent-default-export` used to require an `agent` import from every
 * template's `agent.ts`; it cannot say "one of two", so it keeps the part it
 * can state absolutely (there is a default export) and the choice between the
 * helpers is correlated below, against the value the module actually resolves
 * to rather than against a second grep.
 * `konsistent.json` only asserts what both mounts share (the stylesheet
 * import): its predicates are "must import X", with no "one of", and no way to
 * read a value out of a SIBLING file to decide which. Correlating the two is the
 * whole point — a rule that merely accepted either mount would pass the exact
 * mistake worth catching.
 *
 * That mistake is silent in the direction that matters. A static agent whose
 * page mounts with `mountClient()` renders fine and then opens a `/websocket`
 * the server declines with a protocol error, so the failure is a dead start screen
 * rather than a build error — and it reproduces identically under `aai dev` and
 * in production, which is the only good news about it.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { byCodeUnit } from "./_template-support.ts";

/** Every template's client source, as text. */
const clientSources = import.meta.glob("../templates/*/client.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every template's agent module, lazily — resolved once in `beforeAll` below. */
const agentModules = import.meta.glob("../templates/*/agent.ts");

/** Every template's agent source, as text — the declaration half. */
const agentSources = import.meta.glob("../templates/*/agent.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Each template's resolved `page`, keyed by module path.
 *
 * Loaded ONCE, and that is a flake fix rather than a tidiness one. These are
 * lazy `import.meta.glob` handles, so the first `await load()` in the file pays
 * to transform the whole agent graph — this SDK, its providers, zod — through
 * Vite. Awaited inside a `test.each` case, that cost lands on whichever template
 * happens to be first, so a saturated machine failed
 * `'plan-and-execute': the mount matches what agent.ts declares` on the unit
 * tier's 5s budget while nothing about plan-and-execute was wrong, and the case
 * that pays is an artifact of iteration order. No tier here carries a retry, so
 * a timing failure has to be designed out rather than absorbed.
 *
 * The hook takes its own budget for the shared work and the assertions stay
 * synchronous. A module that fails to load now fails once, naming its path,
 * instead of surfacing as one opaque timeout.
 */
const agentPages = new Map<string, "voice" | "static">();

beforeAll(async () => {
  await Promise.all(
    Object.entries(agentModules).map(async ([path, load]) => {
      const mod = (await load()) as { default?: { page?: "voice" | "static" } };
      // Absent reads as "voice" everywhere else, so it reads that way here.
      agentPages.set(path, mod.default?.page === "static" ? "static" : "voice");
    }),
  );
}, 60_000);

/** The `page` a template resolved to, or a failure naming the template. */
function pageOf(agentPath: string): "voice" | "static" {
  const page = agentPages.get(agentPath);
  if (!page) throw new Error(`No agent.ts beside ${agentPath}`);
  return page;
}

/**
 * One glob's sources as `{ name, source, agentPath }`, in template order.
 *
 * Both corpora below are the same shape over a different glob — the client
 * sources and the agent sources — so the key parse, its failure, and the sort
 * are written once. `agentPath` is derived from the NAME rather than from the
 * key, which is what makes the two agree: a client's entry has to name its
 * sibling agent, and an agent's entry names itself.
 */
const byTemplate = (
  sources: Record<string, string>,
): { name: string; source: string; agentPath: string }[] =>
  Object.entries(sources)
    .map(([path, source]) => {
      const name = path.split("/")[2];
      if (!name) throw new Error(`Unexpected glob key: ${path}`);
      return { name, source, agentPath: `../templates/${name}/agent.ts` };
    })
    .sort((a, b) => byCodeUnit(a.name, b.name));

const clients = byTemplate(clientSources);

/** Which names does `source` import from `spec`? */
function importsFrom(source: string, spec: string): string[] {
  const pattern = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*"${spec}"`, "g");
  return [...source.matchAll(pattern)]
    .flatMap((match) => (match[1] ?? "").split(","))
    .map((name) => name.trim().replace(/^type\s+/, ""));
}

/** Which mount does this source name in its `@alexkroman1/aai-ui` import? */
function mountsWith(source: string): { client: boolean; page: boolean } {
  const imports = importsFrom(source, "@alexkroman1/aai-ui");
  return { client: imports.includes("mountClient"), page: imports.includes("mountPage") };
}

/**
 * `source` with its comments blanked out.
 *
 * Every gate here that greps a source owes this, and this one is where the debt
 * came due: `solo-rpg` names `component:` in a JSDoc paragraph ABOUT the
 * wrapper it deleted, which read as a custom component and failed a template
 * that renders the default shell. Prose that discusses a construct is not that
 * construct — the same distinction `check-test-assertions` pays a real parser
 * for. A blank-out rather than a delete, so nothing on either side of a comment
 * is joined into a token that was never written.
 *
 * It is deliberately not a tokenizer: a `//` inside a string literal is blanked
 * too. Everything read here is a `component:` key or an import list, so the
 * only cost of that is over-blanking a URL, and the alternative is a second
 * parser in a file whose subject is neither.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Every template's client source keyed by template name — absent is a name
 *  with no `client.tsx`, which is the default shell and not an omission. */
const clientByTemplate = new Map(clients.map(({ name, source }) => [name, source]));

/**
 * Does this voice template's UI carry a new-conversation control?
 *
 * Three ways to have one, and the FIRST is the common one: leave `component:`
 * out and the default shell renders `<Controls>`, whose second button is
 * "New Conversation". That covers every template with no `client.tsx` at all
 * and every one that only passes `sidebar:`.
 *
 * A `component:` replaces that shell wholesale, so a template that passes one
 * has to say it itself — either by rendering `<Controls>` inside its own
 * component, or by wiring its own button, which every such template here does
 * through a local `newConversation()`. That name is the greppable half: the
 * control is a BUTTON in three different visual idioms ("New Conversation"
 * twice, "[N]ew Game" in the text-adventure), so its label cannot be the thing
 * this asserts on.
 *
 * **Two occurrences, not one — the declaration is not the control.** A first
 * draft accepted a single `newConversation(` and A/B'd GREEN against a real
 * regression: unwiring `retail`'s button back to a bare `session.end()` left
 * the helper defined and called by nobody, which is exactly the shape this is
 * meant to catch and reads identically to a wired one. The declaration plus at
 * least one call site is the cheapest thing that tells them apart.
 */
function hasNewConversation(source: string | undefined): boolean {
  if (source === undefined) return true;
  const code = withoutComments(source);
  if (!/\bcomponent:/.test(code)) return true;
  if (importsFrom(code, "@alexkroman1/aai-ui").includes("Controls")) return true;
  // `session.restart()` — the SDK method that is this affordance. It used to
  // look for two occurrences of a hand-rolled `newConversation(`, which is what
  // all three of these clients had written because no such method existed; the
  // shipped `<Controls>` called `reset()`, which keeps the session id and so
  // leaves a stateful agent's slot data in place behind a cleared transcript.
  // Matching the METHOD rather than a template's private helper name is also
  // what stops this gate passing on a fourth spelling of the same workaround.
  return /\brestart\b/.test(code);
}

describe("template client mounts", () => {
  test("there is at least one client to check", () => {
    // A glob that stops matching reports zero violations, which reads as a pass.
    expect(clients.length).toBeGreaterThan(0);
  });

  test.each(clients)(
    "$name: mounts with exactly one of mountClient() and mountPage()",
    ({ source }) => {
      const { client, page } = mountsWith(source);
      expect(client || page, "imports neither client nor page from @alexkroman1/aai-ui").toBe(true);
      expect(client && page, "imports both mounts; a client.tsx mounts once").toBe(false);
    },
  );

  test.each(clients)("$name: the mount matches what agent.ts declares", ({ source, agentPath }) => {
    const isStatic = pageOf(agentPath) === "static";
    expect(
      mountsWith(source).page,
      isStatic ? "expected mountPage()" : "expected mountClient()",
    ).toBe(isStatic);
  });
});

const agents = byTemplate(agentSources);

describe("template agent declarations", () => {
  test("there is at least one agent to check, and every one of them loaded", () => {
    // Same reason as above: a glob that stops matching reads as a pass. The
    // second half is new with the shared loader — an empty map would make
    // `pageOf` throw rather than silently pass, but only for templates that
    // still have a case, so the count is what pins the corpus.
    expect(agents.length).toBeGreaterThan(0);
    expect(agentPages.size).toBe(agents.length);
  });

  test.each(agents)(
    "$name: the declaration helper matches what agent.ts resolves to",
    ({ source, agentPath }) => {
      const isStatic = pageOf(agentPath) === "static";
      const imports = importsFrom(source, "@alexkroman1/aai");

      // `workflowApp()` is `agent({ …, page: "static" })` with the discriminant
      // set, so the long form still WORKS — but a template is a worked example,
      // and the helper is what keeps the fields a workflow app cannot use
      // (`systemPrompt`, `tools`, the provider triple) out of it by
      // construction rather than by the author noticing.
      expect(imports.includes("workflowApp"), isStatic ? "expected workflowApp()" : "").toBe(
        isStatic,
      );
      expect(imports.includes("agent"), isStatic ? "" : "expected agent()").toBe(!isStatic);
    },
  );
});

/**
 * Every VOICE template gives the user a way to start a fresh conversation.
 *
 * It is the one control a conversational agent's UI cannot do without and the
 * easiest to lose, because it comes for free: the default shell renders
 * `<Controls>` and nobody writing a template has to think about it — right up
 * until a template passes `component:` and silently drops the whole footer.
 * Two of the three that do had exactly that gap, and it is invisible in a diff
 * (nothing is removed) and invisible to every other gate here.
 *
 * Scoped to voice, deliberately. A workflow app (`page: "static"`) has no
 * conversation to restart; what it has is a run, and clearing one is a
 * different affordance with a different name.
 */
describe("template new-conversation control", () => {
  // Filtered INSIDE each case, not into a `test.each` corpus: `pageOf` reads
  // the map `beforeAll` fills, and a `describe` body runs during collection —
  // before it. The same reason the two describes above take `agents` whole.
  const isVoice = (agentPath: string) => pageOf(agentPath) === "voice";

  test("there is at least one voice template to check", () => {
    // A corpus that stops matching reports no violations, which reads as a pass.
    expect(agents.filter(({ agentPath }) => isVoice(agentPath)).length).toBeGreaterThan(0);
  });

  test.each(agents)("$name: offers a new-conversation control", ({ name, agentPath }) => {
    expect(
      !isVoice(agentPath) || hasNewConversation(clientByTemplate.get(name)),
      "a custom `component:` renders no <Controls>, so this client owes its own new-conversation button",
    ).toBe(true);
  });
});
