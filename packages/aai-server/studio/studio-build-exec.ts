// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio build itself — one workspace materialize feeding the requested
 * Vite passes. Only the build entry (`studio-build-entry.ts`) calls this in
 * anger: the server never builds in its own process (see
 * `studio-build-runner.ts`), so outside of tests this function only ever
 * runs inside a build-worker process.
 */

import type { StudioBuildRequest, StudioBuildResult } from "./studio-build-protocol.ts";
import { bundleWorkspaceWorker } from "./studio-bundle.ts";
import { buildWorkspaceClient } from "./studio-client-build.ts";
import { withWorkspaceDir } from "./studio-workspace-dir.ts";

/**
 * Run the requested builds against one materialized copy of `files`.
 *
 * @throws {StudioBuildError} with Vite diagnostics on compile errors.
 */
export async function executeStudioBuild(req: StudioBuildRequest): Promise<StudioBuildResult> {
  if (!(req.worker || req.client)) return {};
  return withWorkspaceDir(req.files, async (dir) => {
    // The two builds read the same scratch dir and are otherwise independent.
    const [worker, clientFiles] = await Promise.all([
      req.worker ? bundleWorkspaceWorker(dir) : Promise.resolve(undefined),
      req.client ? buildWorkspaceClient(dir) : Promise.resolve(undefined),
    ]);
    return {
      ...(worker !== undefined && { worker }),
      ...(clientFiles !== undefined && { clientFiles }),
    };
  });
}
