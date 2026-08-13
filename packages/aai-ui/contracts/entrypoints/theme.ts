// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `theme`.
 *
 * The tokens a client passes to `client({ theme })` and the hook a component
 * reads them back through. Its own contract rather than part of `client`
 * because a token is a name in someone's CSS: renaming one breaks a page that
 * never calls a function of ours.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export { type ClientTheme, useTheme } from "../../index.ts";
