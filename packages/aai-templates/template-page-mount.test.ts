// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Every template declares its front door consistently at BOTH ends: the helper
 * its `agent.ts` calls, and the mount its `client.tsx` uses.
 *
 * There are two of each and the agent's own `page` field decides which. A VOICE
 * agent is declared with `agent()` and mounts with `client()`, which builds a
 * `SessionCore` — a WebSocket URL provider, an audio graph and a microphone
 * request. A WORKFLOW APP (`page: "static"`) is declared with `workflowApp()`
 * and mounts with `page()`, which builds none of them.
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
 * page mounts with `client()` renders fine and then opens a `/websocket` the
 * server declines with a protocol error, so the failure is a dead start screen
 * rather than a build error — and it reproduces identically under `aai dev` and
 * in production, which is the only good news about it.
 */

import { beforeAll, describe, expect, test } from "vitest";

/** Every template's client source, as text. */
const clientSources = import.meta.glob("./templates/*/client.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every template's agent module, lazily — resolved once in `beforeAll` below. */
const agentModules = import.meta.glob("./templates/*/agent.ts");

/** Every template's agent source, as text — the declaration half. */
const agentSources = import.meta.glob("./templates/*/agent.ts", {
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
      return { name, source, agentPath: `./templates/${name}/agent.ts` };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

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
  return { client: imports.includes("client"), page: imports.includes("page") };
}

describe("template client mounts", () => {
  test("there is at least one client to check", () => {
    // A glob that stops matching reports zero violations, which reads as a pass.
    expect(clients.length).toBeGreaterThan(0);
  });

  test.each(clients)("$name: mounts with exactly one of client() and page()", ({ source }) => {
    const { client, page } = mountsWith(source);
    expect(client || page, "imports neither client nor page from @alexkroman1/aai-ui").toBe(true);
    expect(client && page, "imports both mounts; a client.tsx mounts once").toBe(false);
  });

  test.each(clients)("$name: the mount matches what agent.ts declares", ({ source, agentPath }) => {
    const isStatic = pageOf(agentPath) === "static";
    expect(mountsWith(source).page, isStatic ? "expected page()" : "expected client()").toBe(
      isStatic,
    );
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
