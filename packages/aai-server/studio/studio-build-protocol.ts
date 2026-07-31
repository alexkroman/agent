// Copyright 2026 the AAI authors. MIT license.
/**
 * Wire contract for the studio build worker.
 *
 * Studio builds (the worker and client Vite passes over an untrusted
 * workspace tree) can run out of process — in production as the
 * `studio_build` Modal Function on the server's own image (modal_deploy.py).
 * This module is the contract both sides share: a JSON request naming the
 * files and which artifacts to build, and a JSON response carrying either
 * the artifacts or a classified error.
 *
 * Errors cross the boundary as data, not thrown exceptions, because the hop
 * is a cross-language Modal call: a `StudioBuildError` (a compile error the
 * coding agent can act on) must survive it and be rethrown host-side as the
 * same type, while anything else stays an internal failure. The `kind` field
 * is that classification.
 */

import { z } from "zod";

/** What to build from one materialized workspace. */
export type StudioBuildRequest = {
  files: Record<string, string>;
  /** Build the deployable worker ESM (`bundleWorkspaceWorker`). */
  worker: boolean;
  /** Build the client SPA (`buildWorkspaceClient`). */
  client: boolean;
};

export const StudioBuildRequestSchema = z.object({
  files: z.record(z.string(), z.string()),
  worker: z.boolean(),
  client: z.boolean(),
});

/** Artifacts for the requested targets — each present iff it was requested. */
export type StudioBuildResult = {
  worker?: string;
  clientFiles?: Record<string, string>;
};

export const StudioBuildResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    worker: z.string().optional(),
    clientFiles: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    ok: z.literal(false),
    /**
     * `build` = user-actionable compile error (rethrown as StudioBuildError);
     * `internal` = infrastructure/our bug (rethrown as a plain Error).
     */
    kind: z.enum(["build", "internal"]),
    error: z.string(),
  }),
]);

export type StudioBuildResponse = z.infer<typeof StudioBuildResponseSchema>;

/**
 * A build executor: one workspace materialize, the requested Vite passes.
 * Implementations: `executeStudioBuild` (in-process) and the Modal-backed
 * runner in `studio-build-runner.ts`.
 */
export type StudioBuildRunner = (req: StudioBuildRequest) => Promise<StudioBuildResult>;
