// Copyright 2025 the AAI authors. MIT license.
import dns from "node:dns";
import http from "node:http";
import { expect, test, vi } from "vitest";
import { assertPublicUrl, createSsrfSafeAgent, isPrivateIp } from "./_net.ts";

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

test("assertPublicUrl blocks localhost hostname", async () => {
  await expect(assertPublicUrl("http://localhost/")).rejects.toThrow(
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

test("assertPublicUrl blocks .internal domains", async () => {
  await expect(assertPublicUrl("http://metadata.google.internal/")).rejects.toThrow(
    "Blocked request to private address",
  );
  await expect(assertPublicUrl("http://anything.internal/")).rejects.toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks .local (mDNS) domains", async () => {
  await expect(assertPublicUrl("http://printer.local/")).rejects.toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl allows valid public URLs", async () => {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.spyOn(dns, "lookup").mockImplementation((...args: any[]) => {
    const cb = args.at(-1);
    cb(null, [{ address: "93.184.216.34", family: 4 }]);
  });
  await expect(assertPublicUrl("https://example.com/")).resolves.toBeUndefined();
  await expect(assertPublicUrl("https://api.brave.com/search")).resolves.toBeUndefined();
  vi.restoreAllMocks();
});

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

// ── DNS rebinding prevention ────────────────────────────────────────────

test("assertPublicUrl blocks hostname resolving to private IP", async () => {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.spyOn(dns, "lookup").mockImplementation((...args: any[]) => {
    const cb = args.at(-1);
    cb(null, [{ address: "127.0.0.1", family: 4 }]);
  });
  await expect(assertPublicUrl("http://evil-rebind.example.com/")).rejects.toThrow(
    "Blocked request to private address",
  );
  vi.restoreAllMocks();
});

test("assertPublicUrl blocks hostname resolving to cloud metadata IP", async () => {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.spyOn(dns, "lookup").mockImplementation((...args: any[]) => {
    const cb = args.at(-1);
    cb(null, [{ address: "169.254.169.254", family: 4 }]);
  });
  await expect(assertPublicUrl("http://metadata-rebind.attacker.com/")).rejects.toThrow(
    "Blocked request to private address",
  );
  vi.restoreAllMocks();
});

test("assertPublicUrl blocks hostname resolving to IPv6 loopback", async () => {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.spyOn(dns, "lookup").mockImplementation((...args: any[]) => {
    const cb = args.at(-1);
    cb(null, [{ address: "::1", family: 6 }]);
  });
  await expect(assertPublicUrl("http://ipv6-rebind.attacker.com/")).rejects.toThrow(
    "Blocked request to private address",
  );
  vi.restoreAllMocks();
});

test("assertPublicUrl blocks when any resolved IP is private", async () => {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.spyOn(dns, "lookup").mockImplementation((...args: any[]) => {
    const cb = args.at(-1);
    // One public, one private — should still block
    cb(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
  });
  await expect(assertPublicUrl("http://dual-rebind.attacker.com/")).rejects.toThrow(
    "Blocked request to private address",
  );
  vi.restoreAllMocks();
});

test("assertPublicUrl blocks hostname resolving to IPv4-mapped IPv6 private", async () => {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.spyOn(dns, "lookup").mockImplementation((...args: any[]) => {
    const cb = args.at(-1);
    cb(null, [{ address: "::ffff:127.0.0.1", family: 6 }]);
  });
  await expect(assertPublicUrl("http://mapped-rebind.attacker.com/")).rejects.toThrow(
    "Blocked request to private address",
  );
  vi.restoreAllMocks();
});

test("createSsrfSafeAgent returns an http.Agent", () => {
  const agent = createSsrfSafeAgent("http");
  expect(agent).toBeInstanceOf(http.Agent);
});

test("createSsrfSafeAgent returns an https.Agent for https", () => {
  const agent = createSsrfSafeAgent("https");
  // https.Agent extends http.Agent
  expect(agent).toBeInstanceOf(http.Agent);
});
