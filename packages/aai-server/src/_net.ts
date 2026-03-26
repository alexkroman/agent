// Copyright 2025 the AAI authors. MIT license.

/**
 * Re-exports SSRF protection from the SDK package.
 * The canonical implementation lives in @alexkroman1/aai/_ssrf.ts.
 */
export { assertPublicUrl, isPrivateIp } from "@alexkroman1/aai/ssrf";
