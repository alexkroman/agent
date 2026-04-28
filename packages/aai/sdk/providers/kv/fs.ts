// Copyright 2025 the AAI authors. MIT license.
/** Filesystem KV descriptor — unstorage `fs` driver. */

import type { KvProvider } from "../../providers.ts";

export const FS_KV_KIND = "fs" as const;

export interface FsKvOptions {
  /** Directory to store key files under. Created on first write. */
  base: string;
}

export type FsKvProvider = KvProvider & {
  readonly kind: typeof FS_KV_KIND;
  readonly options: FsKvOptions;
};

export function fsKv(opts: FsKvOptions): FsKvProvider {
  return { kind: FS_KV_KIND, options: { ...opts } };
}
