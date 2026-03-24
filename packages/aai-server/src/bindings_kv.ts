// Copyright 2025 the AAI authors. MIT license.
/**
 * AaiKvNamespace implementation backed by Upstash Redis REST API.
 *
 * @module
 */

import type { AaiKvListResult, AaiKvNamespace } from "./bindings.ts";

export type KvConfig = {
  url: string;
  token: string;
};

type RedisResponse = { result: unknown; error?: string };

async function redisCmd(url: string, token: string, args: string[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Redis error: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as RedisResponse;
  if (body.error) throw new Error(`Redis: ${body.error}`);
  return body.result;
}

export function createKvBinding(config: KvConfig): AaiKvNamespace {
  const { url, token } = config;

  return {
    async get(key) {
      const result = await redisCmd(url, token, ["GET", key]);
      return (result as string) ?? null;
    },

    async put(key, value, options) {
      const args = ["SET", key, value];
      if (options?.expirationTtl && options.expirationTtl > 0) {
        args.push("EX", String(options.expirationTtl));
      }
      await redisCmd(url, token, args);
    },

    async delete(key) {
      await redisCmd(url, token, ["DEL", key]);
    },

    async list(options) {
      const pattern = options?.prefix ? `${options.prefix}*` : "*";
      const keys: string[] = [];
      let cursor = "0";
      do {
        const args = ["SCAN", cursor, "MATCH", pattern];
        if (options?.limit) args.push("COUNT", String(options.limit));
        const result = (await redisCmd(url, token, args)) as [string, string[]];
        cursor = String(result[0]);
        keys.push(...result[1]);
      } while (cursor !== "0");

      const limited = options?.limit ? keys.slice(0, options.limit) : keys;
      const result: AaiKvListResult = {
        keys: limited.map((name) => ({ name })),
        list_complete: limited.length === keys.length,
      };
      return result;
    },
  };
}
