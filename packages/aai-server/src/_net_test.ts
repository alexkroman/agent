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
