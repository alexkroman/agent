// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `testing`.
 *
 * Testing a tool's `execute` in a user's own project: a `ToolContext` with
 * inert defaults and a recording `send`, plus the upload store a `"use step"`
 * body reads through.
 *
 * Re-exported from `@alexkroman1/aai/testing`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  createStubWorkflows,
  createToolContext,
  createUnusedDb,
  type SentEvent,
  type StubGateway,
  type StubGatewayCall,
  type StubGatewayOptions,
  type StubUpload,
  stubGateway,
  stubUploads,
  type TestToolContext,
} from "../../sdk/testing.ts";
