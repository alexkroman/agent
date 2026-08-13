// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Every template's `client.tsx` mounts the way its `agent.ts` says it should.
 *
 * There are two mounts and the agent's own `page` field decides which: a VOICE
 * agent uses `client()`, which builds a `SessionCore` — a WebSocket URL
 * provider, an audio graph and a microphone request — and a WORKFLOW APP
 * (`page: "static"`) uses `page()`, which builds none of them.
 *
 * **konsistent cannot express this**, which is why the check lives here.
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

import { describe, expect, test } from "vitest";

/** Every template's client source, as text. */
const clientSources = import.meta.glob("./templates/*/client.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every template's agent module, lazily — only the ones with a client load. */
const agentModules = import.meta.glob("./templates/*/agent.ts");

const clients = Object.entries(clientSources)
  .map(([path, source]) => {
    const name = path.split("/")[2];
    if (!name) throw new Error(`Unexpected glob key: ${path}`);
    return { name, source, agentPath: `./templates/${name}/agent.ts` };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/** Which mount does this source name in its `@alexkroman1/aai-ui` import? */
function mountsWith(source: string): { client: boolean; page: boolean } {
  // The named-import list of the aai-ui import, whichever line it is on.
  const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@alexkroman1\/aai-ui"/g)]
    .flatMap((match) => (match[1] ?? "").split(","))
    .map((name) => name.trim());
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

  test.each(clients)(
    "$name: the mount matches what agent.ts declares",
    async ({ source, agentPath }) => {
      const load = agentModules[agentPath];
      if (!load) throw new Error(`No agent.ts beside ${agentPath}`);
      const mod = (await load()) as { default?: { page?: "voice" | "static" } };
      // Absent reads as "voice" everywhere else, so it reads that way here.
      const isStatic = mod.default?.page === "static";
      expect(mountsWith(source).page, isStatic ? "expected page()" : "expected client()").toBe(
        isStatic,
      );
    },
  );
});
