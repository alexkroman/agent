// Copyright 2026 the AAI authors. MIT license.
/**
 * Named re-exports over aai-server's `_`-internal utility modules for the
 * aai-studio-server package. Internal modules must not be imported
 * cross-package (biome noPrivateImports); this module is the sanctioned
 * import path for the utilities the studio service legitimately shares.
 * Named (not `export *`) so the shared surface stays deliberate.
 *
 * It was `platform-barrel.ts`, published under a subpath of that name. The name
 * was wrong once the package moved to capability entries: this is a MEMBER of
 * `aai-server/platform` rather than its facade, and `platform-barrel.ts` is what
 * that facade is called. The `-barrel` suffix stays because it is accurate — a
 * pure re-export surface, which is what `konsistent`'s `barrel-files` convention
 * and the co-located-test exemption both key off.
 */

export { resolvePort } from "./_boot.ts";
export { createKeyedLock, withLock } from "./_keyed-lock.ts";
export { createCachedDirReader } from "./_static-files.ts";
export { constantTimeEquals } from "./_timing-safe.ts";
export { TtlCache } from "./_ttl-cache.ts";
