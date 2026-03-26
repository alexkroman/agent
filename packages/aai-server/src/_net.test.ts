// Copyright 2025 the AAI authors. MIT license.
import { expect, test } from "vitest";
import { assertPublicUrl, isPrivateIp } from "./_net.ts";

test("assertPublicUrl blocks localhost", () => {
  expect(() => assertPublicUrl("http://127.0.0.1/")).toThrow("Blocked request to private address");
});

test("assertPublicUrl blocks private IP", () => {
  expect(() => assertPublicUrl("http://192.168.1.1/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks localhost hostname", () => {
  expect(() => assertPublicUrl("http://localhost/")).toThrow("Blocked request to private address");
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

test("assertPublicUrl blocks IPv4-mapped IPv6 loopback", () => {
  expect(() => assertPublicUrl("http://[::ffff:127.0.0.1]/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks IPv4-mapped IPv6 private range", () => {
  expect(() => assertPublicUrl("http://[::ffff:10.0.0.1]/")).toThrow(
    "Blocked request to private address",
  );
  expect(() => assertPublicUrl("http://[::ffff:192.168.1.1]/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks cloud metadata IP", () => {
  expect(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks .internal domains", () => {
  expect(() => assertPublicUrl("http://metadata.google.internal/")).toThrow(
    "Blocked request to private address",
  );
  expect(() => assertPublicUrl("http://anything.internal/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks .local (mDNS) domains", () => {
  expect(() => assertPublicUrl("http://printer.local/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl allows valid public URLs", () => {
  expect(() => assertPublicUrl("https://example.com/")).not.toThrow();
  expect(() => assertPublicUrl("https://api.brave.com/search")).not.toThrow();
});

test("assertPublicUrl blocks link-local IPv4 range", () => {
  expect(() => assertPublicUrl("http://169.254.1.1/")).toThrow(
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

// ── Missing CIDR block coverage ─────────────────────────────────────────

test("assertPublicUrl blocks 0.0.0.0/8 (current network)", () => {
  expect(() => assertPublicUrl("http://0.0.0.0/")).toThrow("Blocked request to private address");
  expect(() => assertPublicUrl("http://0.255.255.255/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks 100.64.0.0/10 (CGN / RFC 6598)", () => {
  expect(() => assertPublicUrl("http://100.64.0.1/")).toThrow("Blocked request to private address");
  expect(() => assertPublicUrl("http://100.127.255.254/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks 192.0.0.0/24 (IETF protocol assignments)", () => {
  expect(() => assertPublicUrl("http://192.0.0.1/")).toThrow("Blocked request to private address");
  expect(() => assertPublicUrl("http://192.0.0.254/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks 198.18.0.0/15 (benchmarking)", () => {
  expect(() => assertPublicUrl("http://198.18.0.1/")).toThrow("Blocked request to private address");
  expect(() => assertPublicUrl("http://198.19.255.254/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks 224.0.0.0/4 (multicast)", () => {
  expect(() => assertPublicUrl("http://224.0.0.1/")).toThrow("Blocked request to private address");
  expect(() => assertPublicUrl("http://239.255.255.255/")).toThrow(
    "Blocked request to private address",
  );
});

test("assertPublicUrl blocks 240.0.0.0/4 (reserved)", () => {
  expect(() => assertPublicUrl("http://240.0.0.1/")).toThrow("Blocked request to private address");
  expect(() => assertPublicUrl("http://255.255.255.254/")).toThrow(
    "Blocked request to private address",
  );
});

test("isPrivateIp covers all registered CIDR blocks", () => {
  // 0.0.0.0/8
  expect(isPrivateIp("0.0.0.0")).toBe(true);
  // 100.64.0.0/10 (CGN)
  expect(isPrivateIp("100.64.0.1")).toBe(true);
  // 192.0.0.0/24
  expect(isPrivateIp("192.0.0.1")).toBe(true);
  // 198.18.0.0/15 (benchmarking)
  expect(isPrivateIp("198.18.0.1")).toBe(true);
  // 224.0.0.0/4 (multicast)
  expect(isPrivateIp("224.0.0.1")).toBe(true);
  // 240.0.0.0/4 (reserved)
  expect(isPrivateIp("240.0.0.1")).toBe(true);
});

test("isPrivateIp boundary: last address in 172.16.0.0/12", () => {
  expect(isPrivateIp("172.31.255.255")).toBe(true);
  // First address outside the range
  expect(isPrivateIp("172.32.0.0")).toBe(false);
});

test("isPrivateIp boundary: edges of 100.64.0.0/10 (CGN)", () => {
  expect(isPrivateIp("100.64.0.0")).toBe(true);
  expect(isPrivateIp("100.127.255.255")).toBe(true);
  // Just outside
  expect(isPrivateIp("100.128.0.0")).toBe(false);
});

test("isPrivateIp detects IPv6 multicast", () => {
  expect(isPrivateIp("ff02::1")).toBe(true);
});
