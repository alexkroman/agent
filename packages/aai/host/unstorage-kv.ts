// Copyright 2025 the AAI authors. MIT license.

import { prefixStorage, type Storage, type StorageValue } from "unstorage";
import { MAX_VALUE_SIZE } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";

type UnstorageKvOptions = {
  storage: Storage;
  prefix?: string;
};

// Wrapper-level expiry envelope. `store.setItem(..., { ttl })` is only honored
// by the Redis driver — memory, fs, and S3 silently ignore it, so a value set
// with `expireIn` would live forever (session notes never expire, the store
// grows unbounded, and `recall` can surface a stale session's data). Stamping
// an absolute expiry into the stored payload and enforcing it on read makes
// TTL work on every driver. Only written when a TTL is requested, so untimed
// values keep their plain representation and pre-existing data still reads.
const EXP_KEY = "__aai_expires_at_ms";
interface ExpiryEnvelope {
  [EXP_KEY]: number;
  v: unknown;
}

function isExpiryEnvelope(raw: unknown): raw is ExpiryEnvelope {
  return (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as Record<string, unknown>)[EXP_KEY] === "number" &&
    "v" in raw
  );
}

export function createUnstorageKv(options: UnstorageKvOptions): Kv {
  const store = options.prefix ? prefixStorage(options.storage, options.prefix) : options.storage;

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const raw = await store.getItem<unknown>(key);
      if (raw === null || raw === undefined) return null;
      if (isExpiryEnvelope(raw)) {
        if (Date.now() >= raw[EXP_KEY]) {
          // Expired: drop it lazily and report missing per the Kv contract.
          void store.removeItem(key).catch(() => undefined);
          return null;
        }
        return (raw.v ?? null) as T | null;
      }
      return raw as T;
    },

    async set(key: string, value: unknown, setOptions?: { expireIn?: number }): Promise<void> {
      // Serialize once for the size check; the stored representation shares the
      // same JSON string (unstorage round-trips it back via destr on get).
      const json = JSON.stringify(value);
      // JSON.stringify returns undefined for undefined/function/symbol —
      // Kv values are JSON-serialized (see sdk/kv.ts), so reject loudly
      // instead of throwing a confusing TypeError on `.length` below.
      if (json === undefined) {
        throw new TypeError(`Kv.set("${key}"): value is not JSON-serializable`);
      }
      // Byte length, not `.length`: the cap and its error message are in bytes,
      // but String.length counts UTF-16 code units, so multi-byte content (CJK,
      // emoji) could be several times the stated limit yet still pass — and then
      // be rejected downstream by a byte-limited backend (Redis/S3).
      if (Buffer.byteLength(json) > MAX_VALUE_SIZE) {
        throw new Error(`Value exceeds max size of ${MAX_VALUE_SIZE} bytes`);
      }
      const expireIn = setOptions?.expireIn;
      if (expireIn && expireIn > 0) {
        const envelope: ExpiryEnvelope = { [EXP_KEY]: Date.now() + expireIn, v: value };
        // Still pass `ttl` so Redis also expires server-side (bounds its memory);
        // the envelope is what makes every other driver honor the TTL.
        await store.setItem(key, JSON.stringify(envelope) as StorageValue, {
          ttl: Math.ceil(expireIn / 1000),
        });
        return;
      }
      await store.setItem(key, json as StorageValue);
    },

    async delete(keys: string | string[]): Promise<void> {
      const keyArray = Array.isArray(keys) ? keys : [keys];
      await Promise.all(keyArray.map((k) => store.removeItem(k)));
    },

    close() {
      // Best-effort: close() is fire-and-forget by contract, and a dispose
      // failure on teardown is not actionable — swallow sync and async errors.
      Promise.resolve()
        .then(() => store.dispose())
        .catch(() => undefined);
    },
  };
}
