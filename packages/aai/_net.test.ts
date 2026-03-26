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
