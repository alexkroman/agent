// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai dev` serves the project's own `workflows/` SOURCE and still proxies the
 * workflow API — the two things `WORKFLOW_API_PREFIX` makes compete for one URL
 * space.
 *
 * `/workflows` is a Vite proxy PREFIX key and also the directory the SDK tells
 * authors to put workflow bodies in. `transcription-workflow/client.tsx` has a
 * value import of `./workflows/stitch.ts`, which Vite rewrites to the absolute
 * `/workflows/stitch.ts` during import analysis — so the proxy claimed it, the
 * agent server answered the `404 {"error":"Not found"}` its workflow router
 * gives any unmatched path under the prefix, the browser refused a module served
 * as `application/json`, and the page rendered BLANK.
 *
 * **This is the SCENARIO tier because nothing cheaper can see it.** The defect
 * is not in the config object — it is in Vite's middleware ORDER, the proxy
 * running ahead of the transform pipeline. A unit assertion on the shape of
 * `server.proxy` passes for any `bypass` at all, including one that returns the
 * wrong verdict, and the sibling unit suite's assertions were all green
 * throughout. So the test has to be a real Vite dev server on a real port,
 * asked the two questions a browser asks, with a stub agent server behind it.
 *
 * The backend is a plain `http.createServer` rather than `startDevServer`
 * deliberately: what is under test is which of two servers answers a URL, and a
 * real agent server would add provider credentials, a bundle and an agent
 * definition to a test about routing. It ANSWERS DISTINGUISHABLY (`x-served-by`)
 * so a passing assertion cannot be satisfied by the wrong server.
 */

import fs from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import getPort from "get-port";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { describe, expect, test } from "vitest";
import { viteDevConfig } from "./_dev-vite-config.ts";
import { withTempDir } from "./_test-utils.ts";

/** What the browser asks for, and what a module answer has to look like. */
const SOURCE_MODULE_URL = "/workflows/stitch.ts";

/**
 * The stub agent server: every request is answered, and every answer says so.
 *
 * A 404 would be indistinguishable from Vite's own SPA fallback, and a 200 with
 * no marker would be indistinguishable from a served module — both of which are
 * ways this test could pass while the bug is present.
 */
function startBackend(port: number): Promise<Server> {
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-served-by": "backend" });
    res.end(JSON.stringify({ saw: req.url }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/** A project shaped like every workflow template: bodies under `workflows/`. */
async function writeProject(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "workflows"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "workflows", "stitch.ts"),
    'export const TRANSCRIPT_STREAM = "transcript";\nexport function stitchChunks() {\n  return "stitched";\n}\n',
  );
  await fs.writeFile(
    path.join(dir, "client.tsx"),
    'import { stitchChunks } from "./workflows/stitch.ts";\nconsole.log(stitchChunks());\n',
  );
  await fs.writeFile(
    path.join(dir, "index.html"),
    '<!doctype html><html><body><script type="module" src="/client.tsx"></script></body></html>',
  );
}

/** What a case is handed: a live Vite dev server and where to dial it. */
type Booted = { origin: string; vite: ViteDevServer };

/**
 * A temp project, a Vite server over it, and a stub backend behind the proxy —
 * torn down INSIDE the temp directory's lifetime.
 *
 * The order matters and cost a failure to learn: Vite's dependency scan keeps
 * reading the root (and writing its cache into it) after `listen()` resolves, so
 * a teardown in `afterEach` runs after `withTempDir` has already removed the
 * directory — which surfaced as `ENOTEMPTY` on cleanup and an `ENOENT` on
 * `index.html` from inside rolldown, i.e. as two errors about the harness in a
 * test whose subject is routing.
 */
async function withBootedProject(run: (booted: Booted) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    await writeProject(dir);
    const [vitePort, backendPort] = [await getPort(), await getPort()];
    const backend = await startBackend(backendPort);
    const vite = await createViteServer(viteDevConfig(dir, vitePort, backendPort));
    try {
      await vite.listen();
      // The IPv4 literal, not `localhost`: this suite is also the only place the
      // bind host is observable, and dialling a hostname would pass against a
      // server bound to `::1` alone.
      await run({ origin: `http://127.0.0.1:${vitePort}`, vite });
    } finally {
      await vite.close();
      backend.close();
    }
  });
}

describe("aai dev's workflow prefix", () => {
  test("serves a workflows/ source module as a MODULE, not as the API's 404", async () => {
    await withBootedProject(async ({ origin }) => {
      const res = await fetch(`${origin}${SOURCE_MODULE_URL}`);

      // The three independent halves of "the browser can run this".
      expect(res.status).toBe(200);
      expect(res.headers.get("x-served-by")).toBe(null);
      // A module script is refused outright for any other content type, which
      // is what turned a 200 from the API into a blank page rather than an error.
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toContain("stitchChunks");
    });
  });

  test("the client's own import of that module resolves to a path Vite serves", async () => {
    // The URL under test is not one anybody types — it is what Vite's import
    // analysis rewrites `./workflows/stitch.ts` to. Asserting the rewrite is
    // what keeps the test above pointed at the request a browser really makes,
    // including if Vite's specifier handling ever changes.
    await withBootedProject(async ({ origin }) => {
      const res = await fetch(`${origin}/client.tsx`);

      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`"${SOURCE_MODULE_URL}"`);
    });
  });

  test("HMR's own query does not put the module back behind the proxy", async () => {
    // Vite re-requests a changed module as `?import&t=<ts>`. The bypass reads a
    // request TARGET, not a path, so a query it failed to cut would send every
    // post-edit request for a workflow body to the agent server — i.e. the page
    // works until the author saves the file.
    await withBootedProject(async ({ origin }) => {
      const res = await fetch(`${origin}${SOURCE_MODULE_URL}?import&t=1750000000000`);

      expect(res.headers.get("x-served-by")).toBe(null);
      expect(res.headers.get("content-type")).toContain("javascript");
    });
  });

  test.each([
    ["the listing route", "/workflows"],
    ["the runs collection", "/workflows/runs"],
    ["a run's events stream", "/workflows/runs/run_123/events"],
    ["an uploads part", "/workflows/uploads/up_1/parts"],
    ["a path with no file behind it", "/workflows/never-written.ts"],
  ])("still proxies %s to the agent server", async (_label, url) => {
    // The other half of the fix, and the one a naive "let Vite win" would break:
    // a `page: "static"` app's entire front door is these routes, and the last
    // case is why the filesystem is the discriminator rather than an extension
    // or a query — an unknown path belongs to the API, which is the end that can
    // say what is wrong with it.
    await withBootedProject(async ({ origin }) => {
      const res = await fetch(`${origin}${url}`);

      expect(res.headers.get("x-served-by")).toBe("backend");
      expect(await res.json()).toEqual({ saw: url });
    });
  });

  test("binds a loopback address the IPv4 literal can reach", async () => {
    // Vite's default `server.host` is the HOSTNAME `localhost`, so Node binds
    // whatever `getaddrinfo` answers first — measured `::1` on macOS, where
    // `http://127.0.0.1:<port>` was then ECONNREFUSED against a healthy server
    // whose URL `aai dev` prints as `http://localhost:<port>`. Every fetch above
    // dials the literal, so this suite would fail wholesale on a regression;
    // this asserts the address directly so the failure names the cause.
    await withBootedProject(async ({ vite }) => {
      // `address()` answers `string | AddressInfo | null`, and the field that
      // matters is the one every fetch above depends on — so this asserts the
      // bound address itself rather than the shape of the reply.
      const address = vite.httpServer?.address();
      expect(address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    });
  });
});
