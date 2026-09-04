// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The gate screens' failure card. A gate is the whole page — there is no app
// behind it to degrade into — so the two things asserted here are that a
// failure never reads as a wait, and that it always ends somewhere the user
// can act.

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "./api-error.ts";
import { GateProblem, gateProblem, loadFailureText, SERVER_BUSY_MESSAGE } from "./gate-card.tsx";

describe("loadFailureText", () => {
  test("a server that never answered reads as busy, not as a bug in the page", () => {
    // What a hung request and an unreachable server settle as. Neither
    // message is worth showing the user ("signal timed out" reads as a
    // front-end fault), so neither carries detail.
    for (const err of [
      new DOMException("The operation timed out", "TimeoutError"),
      new TypeError("Failed to fetch"),
    ]) {
      expect(loadFailureText(err, "Could not load your account")).toEqual({
        message: SERVER_BUSY_MESSAGE,
      });
    }
  });

  test("a busy server's own answer is quoted as detail under the busy line", () => {
    expect(loadFailureText(new ApiError(503, "Service unavailable"), "Could not load X")).toEqual({
      message: SERVER_BUSY_MESSAGE,
      detail: "Service unavailable",
    });
  });

  test("a definite refusal is quoted verbatim — it is what names the problem", () => {
    const { message } = loadFailureText(
      new ApiError(403, "Account suspended"),
      "Could not load your account",
    );
    expect(message).toBe("Could not load your account: Account suspended");
  });

  test("a definite failure with no message still says what could not be loaded", () => {
    // `errorMessage` names the class and says the error carried no message,
    // which is what the local "unknown error" placeholder used to stand in for
    // and is strictly more than it said. The placeholder is still the floor for
    // a value that answers nothing at all.
    expect(loadFailureText(new ApiError(400, ""), "Could not load your account").message).toBe(
      "Could not load your account: Error (no message)",
    );
  });
});

/**
 * Drive a real query so the assertions below are about TanStack's actual
 * state, not a hand-written imitation of it: the whole point of `gateProblem`
 * is which field a failure shows up in, and only the real thing can say.
 */
function observeFailingQuery(queryFn: () => Promise<unknown>, retries: number) {
  const client = new QueryClient();
  const observer = new QueryObserver(client, {
    queryKey: ["gate"],
    queryFn,
    retry: (count: number) => count < retries,
    // Long enough that the assertions land mid-backoff, with a retry pending.
    retryDelay: 5000,
  });
  // Subscribing is what makes the query fetch at all; the callback is only
  // the push channel, and every assertion reads `getCurrentResult()` instead.
  const unsubscribe = observer.subscribe(vi.fn());
  return { result: () => observer.getCurrentResult(), unsubscribe };
}

describe("gateProblem", () => {
  test("a first attempt still in flight is a plain wait, not a problem", () => {
    const hangs = () =>
      new Promise<never>(() => {
        /* never settles — the request the deadline exists for */
      });
    const { result, unsubscribe } = observeFailingQuery(hangs, 1);
    expect(gateProblem(result(), "Could not load your account")).toBeNull();
    unsubscribe();
  });

  test("ONE failed attempt is already a problem, while the retries keep running", async () => {
    // The regression this guards: a failure mid-retry lives in
    // `failureReason` and leaves `error` null, so a gate reading `error`
    // alone shows "Loading…" for the whole backoff — indistinguishable from
    // a server that is merely slow, with no way out but a reload.
    const { result, unsubscribe } = observeFailingQuery(
      () => Promise.reject(new ApiError(503, "Service unavailable")),
      1,
    );
    // Generous budget: the default 1s is enough on an idle machine and not
    // always under a full parallel test run, and nothing here is timing-sensitive
    // beyond "the attempt has failed by now".
    await vi.waitFor(() => expect(result().failureCount).toBe(1), { timeout: 3000 });
    expect(result().error).toBeNull();
    expect(result().status).toBe("pending");

    const problem = gateProblem(result(), "Could not load your account");
    expect(problem?.message).toBe(SERVER_BUSY_MESSAGE);
    expect(problem?.detail).toBe("Service unavailable");
    // A retry is pending, so the card must not offer a press that would fold
    // into it and appear to do nothing.
    expect(problem?.retrying).toBe(true);
    unsubscribe();
  });

  test("out of retries, the problem stands and its retry re-runs the query", async () => {
    const queryFn = vi.fn(() => Promise.reject(new ApiError(503, "Service unavailable")));
    const { result, unsubscribe } = observeFailingQuery(queryFn, 0);
    await vi.waitFor(() => expect(result().status).toBe("error"), { timeout: 3000 });

    const problem = gateProblem(result(), "Could not load your account");
    expect(problem?.message).toBe(SERVER_BUSY_MESSAGE);
    expect(problem?.retrying).toBe(false);
    problem?.onRetry?.();
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2), { timeout: 3000 });
    unsubscribe();
  });
});

describe("GateProblem", () => {
  test("shows the message, the detail, and a working retry", () => {
    const onRetry = vi.fn();
    render(<GateProblem message="Busy" detail="Service unavailable" onRetry={onRetry} />);
    expect(screen.getByText("Busy")).toBeDefined();
    expect(screen.getByText("Service unavailable")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("an automatic retry already in flight is said out loud, and the button is inert", () => {
    // A press during the query layer's own backoff folds into the in-flight
    // attempt rather than starting one, so an enabled button would lie.
    const onRetry = vi.fn();
    render(<GateProblem message="Busy" retrying onRetry={onRetry} />);
    const button = screen.getByRole("button", { name: "Retrying…" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("no retry offered when trying again cannot help", () => {
    render(<GateProblem message="Sign-in is not configured on this server" />);
    expect(screen.getByText("Sign-in is not configured on this server")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
