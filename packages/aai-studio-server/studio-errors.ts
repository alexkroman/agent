// Copyright 2025 the AAI authors. MIT license.

/**
 * Build/materialize failure whose message is safe to show as-is.
 *
 * Workspace builds themselves run in the guest sandbox now (see
 * aai-guest/studio-build.ts, which also owns diagnostic scrubbing); this
 * class remains for the host-side workspace materializer and the eval
 * suite's build gate.
 */
export class StudioBuildError extends Error {}
