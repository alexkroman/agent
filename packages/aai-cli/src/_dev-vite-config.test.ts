// Copyright 2026 the AAI authors. MIT license.
/**
 * Which of two servers owns a URL under `/workflows` — the decision the dev
 * server's proxy `bypass` makes, on its own.
 *
 * `/workflows` is a Vite proxy PREFIX key and also the directory the SDK tells
 * authors to put workflow bodies in, so the two claim one URL space. A string
 * key prefix-matches, which is what makes one entry cover `/runs/:id/events` —
 * and it also swallowed a browser module's value import of
 * `./workflows/stitch.ts`, which Vite rewrites to the absolute
 * `/workflows/stitch.ts` during import analysis: the proxy claimed it, the agent
 * server answered the `404 {"error":"Not found"}` its workflow router gives any
 * unmatched path under the prefix, the browser refused a module served as
 * `application/json`, and the page rendered BLANK.
 *
 * `dev-vite-workflow-proxy.scenario.test.ts` proves the fix end to end, through
 * a real Vite server on a real port — that tier is the only one that can see
 * Vite's middleware ORDER. What it cannot do cheaply is enumerate the DECISION:
 * a percent-escape nobody can decode, a real file outside the root, a directory
 * where a file was expected. Those are properties of one function, and this is
 * where they are pinned.
 *
 * The root is the real `transcription-workflow` template rather than a
 * fabricated directory, because the defect lands on the naming convention every
 * workflow template follows and not on one template's bad luck. Nothing here
 * writes: the template is read exactly as `aai dev` would read a user's project.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { WORKFLOW_API_PREFIX } from "@alexkroman1/aai-runtime";
import type { ProxyOptions } from "vite";
import { describe, expect, test } from "vitest";
import { viteDevConfig } from "./_dev-vite-config.ts";

/** A project shaped like every workflow template: bodies under `workflows/`. */
const PROJECT = path.resolve(
  import.meta.dirname,
  "../../aai-templates/templates/transcription-workflow",
);

/**
 * The workflow body one of this template's BROWSER modules value-imports — the
 * shape of the import the bug ate.
 *
 * Derived rather than named, because the templates are edited often and a
 * hard-coded `stitch.ts` would turn a rename into a test about a path with no
 * file behind it — which is a silent pass for every "the API owns this" case
 * below. What has to hold is the CONVENTION, so that is what is read.
 */
function importedWorkflowBody(): string {
  for (const file of readdirSync(PROJECT).filter((name) => name.endsWith(".tsx"))) {
    const specifier = /from "\.\/workflows\/([\w.-]+)"/.exec(
      readFileSync(path.join(PROJECT, file), "utf-8"),
    );
    if (specifier?.[1] !== undefined) return specifier[1];
  }
  throw new Error(`no *.tsx in ${PROJECT} imports a workflows/ body`);
}

const SOURCE_MODULE = importedWorkflowBody();

/** The workflow proxy entry, or a throw naming what was found instead. */
function workflowProxyEntry(): ProxyOptions {
  const entry = viteDevConfig(PROJECT, 3000, 3001).server?.proxy?.[WORKFLOW_API_PREFIX];
  if (entry === undefined || typeof entry === "string") {
    throw new Error(`no workflow proxy entry with a bypass: ${JSON.stringify(entry)}`);
  }
  return entry;
}

/**
 * Ask the bypass who owns a request target.
 *
 * A real `IncomingMessage` rather than a `{ url }` literal narrowed with a cast:
 * the hook is typed against the request, and a cast would stop reporting the
 * moment it started reading a second field off it.
 */
async function ownedByVite(rawUrl: string | undefined): Promise<string | undefined> {
  const entry = workflowProxyEntry();
  const bypass = entry.bypass;
  if (bypass === undefined) throw new Error("the workflow proxy entry carries no bypass");
  const req = new IncomingMessage(new Socket());
  req.url = rawUrl;
  const verdict = await bypass(req, new ServerResponse(req), entry);
  // `false` is Vite's "404 this without proxying", which this hook never
  // returns — flatten the rest of the union to the two answers it does give.
  return typeof verdict === "string" ? verdict : undefined;
}

describe("the workflow prefix's bypass", () => {
  test("roots at a template whose browser code really imports a workflows/ body", () => {
    // The premise of every case below, and the reason this collision exists at
    // all. The specifier carries its extension, which is what Vite rewrites to
    // the absolute `/workflows/<name>` a browser then asks the proxy for.
    expect(SOURCE_MODULE).toMatch(/\.tsx?$/);
    expect(existsSync(path.join(PROJECT, "workflows", SOURCE_MODULE))).toBe(true);
  });

  test("hands a workflows/ source module to Vite, unchanged", async () => {
    // Returned VERBATIM, query included: Vite must see the request it would have
    // seen with no proxy in front of it at all.
    const url = `${WORKFLOW_API_PREFIX}/${SOURCE_MODULE}`;
    await expect(ownedByVite(url)).resolves.toBe(url);
  });

  test("keeps it with Vite once HMR starts appending its own query", async () => {
    // Vite re-requests a changed module as `?import&t=<ts>`. The hook reads a
    // request TARGET, not a path, so a query it failed to cut would send every
    // post-edit request for a workflow body to the agent server — i.e. the page
    // works until the author saves the file.
    const url = `${WORKFLOW_API_PREFIX}/${SOURCE_MODULE}?import&t=1750000000000`;
    await expect(ownedByVite(url)).resolves.toBe(url);
  });

  test.each([
    ["the listing route", ""],
    ["the runs collection", "/runs"],
    ["a run's events stream", "/runs/run_123/events"],
    ["an uploads part", "/uploads/up_1/parts"],
    ["a path with no file behind it", "/never-written.ts"],
  ])("leaves %s to the API", async (_label, suffix) => {
    // The half a naive "let Vite win" would break: a `page: "static"` app's
    // entire front door is these routes. The last case is why the filesystem is
    // the discriminator rather than an extension or a query — an unknown path
    // belongs to the API, which is the end that can say what is wrong with it.
    // The first is why a DIRECTORY is not a file: `workflows/` exists in this
    // very root, and the listing route still has to reach the API.
    await expect(ownedByVite(`${WORKFLOW_API_PREFIX}${suffix}`)).resolves.toBeUndefined();
  });

  test("resolves no extension, so a body named runs.ts cannot shadow /runs", async () => {
    // Deliberate, and the reason the whole API stays reachable: a workflow body
    // named `runs.ts` is entirely plausible, and `/workflows/runs` must not find
    // it. Nothing is lost — Vite resolves specifiers SERVER-side and rewrites
    // them to paths that exist, so the browser only ever asks for files Vite
    // already found, with the extension on.
    const extensionless = `${WORKFLOW_API_PREFIX}/${path.parse(SOURCE_MODULE).name}`;
    await expect(ownedByVite(extensionless)).resolves.toBeUndefined();
  });

  test("refuses a real file OUTSIDE the project root", async () => {
    // A raw client can send `..` where a browser would normalize it. The file is
    // asserted present FIRST, and from the same target string, so this cannot
    // pass by the traversal simply landing on nothing — what is checked is that
    // the root boundary refuses a path that really resolves. (Verified by A/B:
    // with the boundary check removed, this is the only case that fails, and an
    // earlier draft that counted one `..` too few passed against it.)
    const traversal = `${WORKFLOW_API_PREFIX}/../../../../aai-cli/package.json`;
    expect(existsSync(path.resolve(PROJECT, `.${traversal}`))).toBe(true);

    await expect(ownedByVite(traversal)).resolves.toBeUndefined();
  });

  test("leaves a malformed percent-escape to the API", async () => {
    // A path we cannot decode is a path we cannot resolve, and the API is the
    // end that can say so — guessing at it here would be a second URL parser.
    await expect(ownedByVite(`${WORKFLOW_API_PREFIX}/%ZZ`)).resolves.toBeUndefined();
  });

  test("leaves a request with no target at all to the API", async () => {
    // `IncomingMessage.url` is optional, so the absent case is representable
    // and must not reach `path.resolve` as the string "undefined".
    await expect(ownedByVite(undefined)).resolves.toBeUndefined();
  });
});
