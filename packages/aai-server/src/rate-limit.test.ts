// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConnectionLimiter, RateLimiter } from "./rate-limit.ts";

describe("RateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("allows requests within limit", () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(true);
    limiter.dispose();
  });

  test("rejects requests over limit", () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
    limiter.dispose();
  });

  test("different keys are independent", () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("b")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
    expect(limiter.consume("b")).toBe(false);
    limiter.dispose();
  });

  test("window expires and allows new requests", () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(limiter.consume("a")).toBe(true);
    limiter.dispose();
  });

  test("reset clears all state", () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
    limiter.reset();
    expect(limiter.consume("a")).toBe(true);
    limiter.dispose();
  });
});

describe("ConnectionLimiter", () => {
  test("allows connections within limit", () => {
    const limiter = new ConnectionLimiter(2);
    expect(limiter.acquire("slug")).toBe(true);
    expect(limiter.acquire("slug")).toBe(true);
    expect(limiter.count("slug")).toBe(2);
  });

  test("rejects connections over limit", () => {
    const limiter = new ConnectionLimiter(2);
    expect(limiter.acquire("slug")).toBe(true);
    expect(limiter.acquire("slug")).toBe(true);
    expect(limiter.acquire("slug")).toBe(false);
  });

  test("release frees a slot", () => {
    const limiter = new ConnectionLimiter(1);
    expect(limiter.acquire("slug")).toBe(true);
    expect(limiter.acquire("slug")).toBe(false);
    limiter.release("slug");
    expect(limiter.acquire("slug")).toBe(true);
  });

  test("different keys are independent", () => {
    const limiter = new ConnectionLimiter(1);
    expect(limiter.acquire("a")).toBe(true);
    expect(limiter.acquire("b")).toBe(true);
    expect(limiter.acquire("a")).toBe(false);
  });

  test("release below zero is safe", () => {
    const limiter = new ConnectionLimiter(1);
    limiter.release("nonexistent");
    expect(limiter.count("nonexistent")).toBe(0);
  });

  test("reset clears all state", () => {
    const limiter = new ConnectionLimiter(1);
    limiter.acquire("a");
    limiter.reset();
    expect(limiter.count("a")).toBe(0);
    expect(limiter.acquire("a")).toBe(true);
  });
});
