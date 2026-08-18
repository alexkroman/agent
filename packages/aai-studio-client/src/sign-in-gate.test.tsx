// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The sign-in screen, and the read that decides what is on it.
//
// The property under test throughout: the screen offers exactly the methods the
// auth backend HAS. Everything else here follows from that — a button for a
// disabled provider answers `provider is not enabled` after a round trip through
// somebody else's site, and a missing button for an enabled one is a login the
// user cannot reach at all.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import {
  button,
  fetchCall,
  input,
  jsonResponse,
  renderWithClient,
  settle,
  stubFetch,
} from "./_test-utils.ts";
import type { SignInCredentials } from "./auth.tsx";
import { readSignInMethods, type SignInMethods } from "./auth-methods.ts";
import { SignInGate } from "./gates.tsx";

const GITHUB_ONLY: SignInMethods = { github: true, password: false };
const PASSWORD_ONLY: SignInMethods = { github: false, password: true };
const BOTH: SignInMethods = { github: true, password: true };
const NEITHER: SignInMethods = { github: false, password: false };

function mount(methods: SignInMethods, mode: "supabase" | "dev" = "supabase") {
  const onSignIn = vi.fn<(creds: SignInCredentials) => Promise<void>>(() => Promise.resolve());
  renderWithClient(<SignInGate mode={mode} methods={methods} onSignIn={onSignIn} />);
  return onSignIn;
}

describe("SignInGate", () => {
  test("offers only GitHub when only GitHub is enabled", () => {
    mount(GITHUB_ONLY);
    expect(button(/Continue with GitHub/)).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    // No divider to draw: there is one method.
    expect(screen.queryByText("or")).toBeNull();
  });

  test("offers only the email form when only email is enabled", () => {
    mount(PASSWORD_ONLY);
    expect(screen.queryByRole("button", { name: /GitHub/ })).toBeNull();
    expect(input("Email")).toBeTruthy();
    expect(input("Password")).toBeTruthy();
    // The blurb may not name a button that is not on the screen.
    expect(screen.getByText(/Sign in with your email/)).toBeTruthy();
  });

  test("offers both, separated, when both are enabled", () => {
    mount(BOTH);
    expect(button(/Continue with GitHub/)).toBeTruthy();
    expect(input("Password")).toBeTruthy();
    expect(screen.getByText("or")).toBeTruthy();
  });

  test("a backend with no method enabled says so instead of showing dead controls", () => {
    mount(NEITHER);
    expect(screen.getByText(/No sign-in method is enabled/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /GitHub|Sign in/ })).toBeNull();
  });

  test("signing in dispatches the password credentials", async () => {
    const onSignIn = mount(PASSWORD_ONLY);
    fireEvent.change(input("Email"), { target: { value: "  dev@local.test  " } });
    fireEvent.change(input("Password"), { target: { value: "devdevdev" } });
    fireEvent.click(button("Sign in"));
    await settle();
    // The email is TRIMMED (a pasted address routinely carries whitespace) and
    // the password is NOT — leading/trailing spaces are legitimate characters in
    // one, and stripping them makes a correct password fail with the message a
    // wrong one gets.
    expect(onSignIn).toHaveBeenCalledWith({
      kind: "password",
      email: "dev@local.test",
      password: "devdevdev",
    });
  });

  test("creating an account is its own action, never a fallback from sign-in", async () => {
    // Signing up because a password was MISTYPED leaves the user authenticated
    // as somebody new with an empty project list, which reads as data loss.
    const onSignIn = mount(PASSWORD_ONLY);
    fireEvent.change(input("Email"), { target: { value: "new@local.test" } });
    fireEvent.change(input("Password"), { target: { value: "hunter2hunter2" } });
    fireEvent.click(button("Create account"));
    await settle();
    expect(onSignIn).toHaveBeenCalledWith({
      kind: "signup",
      email: "new@local.test",
      password: "hunter2hunter2",
    });
  });

  test("an incomplete email form dispatches nothing", async () => {
    const onSignIn = mount(PASSWORD_ONLY);
    fireEvent.click(button("Sign in"));
    fireEvent.change(input("Email"), { target: { value: "dev@local.test" } });
    fireEvent.click(button("Sign in"));
    await settle();
    expect(onSignIn).not.toHaveBeenCalled();
  });

  test("the GitHub button needs no field filled", async () => {
    const onSignIn = mount(BOTH);
    fireEvent.click(button(/Continue with GitHub/));
    await settle();
    expect(onSignIn).toHaveBeenCalledWith({ kind: "github" });
  });

  test("dev mode keeps its own one-field sign-in", async () => {
    // Its method is not GoTrue's, so it is offered on the mode rather than on
    // `methods` — which is why both flags are false here.
    const onSignIn = mount(NEITHER, "dev");
    expect(screen.getByText(/Local dev mode/)).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    fireEvent.change(input("Email"), { target: { value: "me@local.test" } });
    fireEvent.click(button("Sign in"));
    await settle();
    expect(onSignIn).toHaveBeenCalledWith({ kind: "dev", email: "me@local.test" });
  });

  test("a failed attempt shows the backend's own words", async () => {
    const onSignIn = vi.fn<(creds: SignInCredentials) => Promise<void>>(() =>
      Promise.reject(new Error("Invalid login credentials")),
    );
    renderWithClient(<SignInGate mode="supabase" methods={PASSWORD_ONLY} onSignIn={onSignIn} />);
    fireEvent.change(input("Email"), { target: { value: "dev@local.test" } });
    fireEvent.change(input("Password"), { target: { value: "wrong" } });
    fireEvent.click(button("Sign in"));
    // That sentence is the whole difference between a typo and an account that
    // does not exist yet, so it is quoted rather than replaced.
    expect(await screen.findByText("Invalid login credentials")).toBeTruthy();
  });
});

describe("readSignInMethods", () => {
  // `stubFetch` routes by PATHNAME, which is also the thing worth pinning here:
  // the endpoint is GoTrue's own, resolved against the project URL.
  const SETTINGS = "/auth/v1/settings";
  const PROJECT = "http://127.0.0.1:54321";

  test("reads the providers GoTrue reports", async () => {
    const fetchMock = stubFetch({
      [SETTINGS]: () => jsonResponse({ external: { github: true, email: true, google: false } }),
    });
    await expect(readSignInMethods(PROJECT, "sb_publishable_x")).resolves.toEqual(BOTH);
    // The publishable key is the whole credential for this public read.
    expect(fetchCall(fetchMock).init.headers).toMatchObject({ apikey: "sb_publishable_x" });
  });

  test("a provider absent from the payload is OFF", async () => {
    // Read strictly rather than coerced: GoTrue omits nothing today, and a
    // truthiness check would turn a future `"github": "maybe"` into a button.
    stubFetch({ [SETTINGS]: () => jsonResponse({ external: { email: true } }) });
    await expect(readSignInMethods(PROJECT, "k")).resolves.toEqual(PASSWORD_ONLY);
  });

  test("a trailing slash on the project URL resolves to the same endpoint", async () => {
    // The URL comes from the server's own `/studio/auth` payload, so both
    // spellings reach here and neither may produce `/auth/v1/settings` off a
    // truncated origin.
    const fetchMock = stubFetch({
      [SETTINGS]: () => jsonResponse({ external: { github: true } }),
    });
    await expect(readSignInMethods(`${PROJECT}/`, "k")).resolves.toEqual(GITHUB_ONLY);
    expect(fetchCall(fetchMock).url).toBe(`${PROJECT}${SETTINGS}`);
  });

  test.each([
    ["a non-2xx answer", () => jsonResponse({ msg: "nope" }, 500)],
    ["an unparsable body", () => new Response("<html>", { status: 200 })],
    ["a payload with no providers", () => jsonResponse({})],
  ])("%s falls back to GitHub-only, never to nothing", async (_label, route) => {
    // An UNKNOWN answer must not remove the method production actually uses —
    // that would turn one flaky read into a studio nobody can sign in to.
    stubFetch({ [SETTINGS]: route });
    await expect(readSignInMethods(PROJECT, "k")).resolves.toEqual(GITHUB_ONLY);
  });

  test("a rejected fetch falls back the same way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(readSignInMethods(PROJECT, "k")).resolves.toEqual(GITHUB_ONLY);
  });
});
