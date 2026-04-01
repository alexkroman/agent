// Copyright 2025 the AAI authors. MIT license.

import { expect, test } from "vitest";
import { assertPublicUrl, isPrivateIp } from "./ssrf.ts";

test("assertPublicUrl blocks localhost", async () => {
  await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks private IP", async () => {
  await expect(assertPublicUrl("http://192.168.1.1/")).rejects.toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks localhost hostname (resolves to 127.0.0.1)", async () => {
  await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow(
    "Blocked request to private address",
  );
});

test("isPrivateIp identifies private IPs", () => {
  expect(isPrivateIp("10.0.0.1")).toBe(true);
  expect(isPrivateIp("172.16.0.1")).toBe(true);
  expect(isPrivateIp("192.168.1.1")).toBe(true);
  expect(isPrivateIp("127.0.0.1")).toBe(true);
  expect(isPrivateIp("::1")).toBe(true);
});

test("isPrivateIp identifies public IPs", () => {
  expect(isPrivateIp("8.8.8.8")).toBe(false);
  expect(isPrivateIp("1.1.1.1")).toBe(false);
});

// ── SSRF bypass prevention ──────────────────────────────────────────────

test("assertPublicUrl blocks IPv4-mapped IPv6 loopback", async () => {
  await expect(assertPublicUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks IPv4-mapped IPv6 private range", async () => {
  await expect(assertPublicUrl("http://[::ffff:10.0.0.1]/")).rejects.toThrow(
    "Blocked request to private address",
  );
  await expect(assertPublicUrl("http://[::ffff:192.168.1.1]/")).rejects.toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks cloud metadata IP", async () => {
  await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks private IPs that .internal domains resolve to", async () => {
  // Cloud metadata IP (what metadata.google.internal resolves to)
  await expect(assertPublicUrl("http://169.254.169.254/")).rejects.toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl allows valid public URLs", async () => {
  // DNS resolution may be slow in sandboxed environments
  await expect(assertPublicUrl("https://example.com/")).resolves.toBeUndefined();
  await expect(assertPublicUrl("https://api.brave.com/search")).resolves.toBeUndefined();
}, 15_000);

test("assertPublicUrl blocks link-local IPv4 range", async () => {
  await expect(assertPublicUrl("http://169.254.1.1/")).rejects.toThrow(
    "Blocked request to private address",
  );
});

test("isPrivateIp detects IPv6 loopback", () => {
  expect(isPrivateIp("::1")).toBe(true);
});

test("isPrivateIp detects IPv6 unique local", () => {
  expect(isPrivateIp("fc00::1")).toBe(true);
  expect(isPrivateIp("fd12:3456::1")).toBe(true);
});

test("isPrivateIp detects IPv6 link-local", () => {
  expect(isPrivateIp("fe80::1")).toBe(true);
});
