// Copyright 2025 the AAI authors. MIT license.

/**
 * Build failure carrying diagnostics formatted for the chat and the UI.
 *
 * Lives in its own module so the workspace materializer, the worker build,
 * and the client build can all throw it without importing each other.
 */
export class StudioBuildError extends Error {}
