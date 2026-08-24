// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `db`.
 *
 * `ctx.db` — the SQL database scoped to an app, and the result shapes its
 * methods answer with. Split out of the `tool` capability, where it had been
 * one name among seventeen.
 *
 * The split does NOT stop a `Db` change from moving `aai:tool`'s hash, and it
 * is worth being exact about why: API Extractor rolls up FORGOTTEN exports, so
 * `Db`'s full shape sits in every report whose entry point reaches it —
 * `etc/testing.api.md` carries it today under a bare `type Db = {`, exported by
 * nothing. A type that `ToolContext` names is in the tool-authoring surface
 * whatever this file says, and that is correct: a tool body really does write
 * `ctx.db`.
 *
 * What it buys is the CLASSIFICATION. A database change now lands as a
 * signature change on a capability whose report is a few dozen lines and whose
 * name says what moved, instead of only inside `tool`'s, where it is one
 * declaration among the whole authoring surface and the export-list delta —
 * the thing the gate reads to suggest a bump type — is silent about it.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export type { Db } from "../../index.ts";
