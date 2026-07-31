// Copyright 2026 the AAI authors. MIT license.
/**
 * CLI entry for the Modal build worker (`studio_build` in modal_deploy.py).
 *
 * Runs one studio build in its own process on the server's image:
 * `node studio-build-entry.mjs <request.json> <response.json>`. The response
 * file is always written when the request file was readable — a compile
 * error is data for the coding agent, not a process failure — so a nonzero
 * exit means the entry itself broke.
 *
 * The response goes to a file rather than stdout because Vite and its
 * plugins log there; parsing stdout would make the protocol hostage to their
 * output discipline.
 */

import fs from "node:fs/promises";
import { errorMessage } from "@alexkroman1/aai";
import { executeStudioBuild } from "./studio-build-exec.ts";
import {
  StudioBuildRequestSchema,
  type StudioBuildResponse,
  type StudioBuildRunner,
} from "./studio-build-protocol.ts";
import { StudioBuildError } from "./studio-errors.ts";

/**
 * One request → response cycle. Never throws — every failure becomes a
 * classified response the host-side runner rethrows as the right error type.
 * `exec` is injectable for tests; the default is the real in-process build.
 */
export async function runBuildRequest(
  raw: unknown,
  exec: StudioBuildRunner = executeStudioBuild,
): Promise<StudioBuildResponse> {
  const parsed = StudioBuildRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, kind: "internal", error: "Malformed build request" };
  try {
    return { ok: true, ...(await exec(parsed.data)) };
  } catch (err) {
    if (err instanceof StudioBuildError) return { ok: false, kind: "build", error: err.message };
    return { ok: false, kind: "internal", error: errorMessage(err) };
  }
}

async function main(): Promise<void> {
  const [requestPath, responsePath] = process.argv.slice(2);
  if (!(requestPath && responsePath)) {
    throw new Error("Usage: studio-build-entry <request.json> <response.json>");
  }
  const raw: unknown = JSON.parse(await fs.readFile(requestPath, "utf-8"));
  const response = await runBuildRequest(raw);
  await fs.writeFile(responsePath, JSON.stringify(response), "utf-8");
}

// Run only as a CLI — tests import runBuildRequest without side effects.
if (/studio-build-entry\.(mjs|ts)$/.test(process.argv[1] ?? "")) {
  main().then(
    // Explicit exit: Vite can leave live handles behind; the response is
    // already on disk, so don't wait for them to drain.
    () => process.exit(0),
    (err: unknown) => {
      console.error(`studio-build-entry failed: ${errorMessage(err)}`);
      process.exit(1);
    },
  );
}
