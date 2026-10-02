// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The three gate screens: sign in, store an AssemblyAI key, approve an
// `aai login` handshake.
//
// The sign-in screen's property throughout (moved from sign-in-gate.test.tsx):
// it offers exactly the methods the auth backend HAS. Everything else follows
// from that — a button for a disabled provider answers `provider is not
// enabled` after a round trip through somebody else's site, and a missing
// button for an enabled one is a login the user cannot reach at all. The read
// that decides what is on it is auth-methods.test.ts's.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import {
  button,
  fetchCall,
  fetchCallsWith,
  input,
  jsonResponse,
  renderWithClient,
  stubFetch,
  tick,
} from "../_test-utils.ts";
import type { SignInCredentials } from "../auth.tsx";
import type { SignInMethods } from "../auth-methods.ts";
import { linkConfirmationCode } from "../cli-link.ts";
import { CliLinkGate, KeyGate, SignInGate } from "./gates.tsx";

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
    await tick();
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
    await tick();
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
    await tick();
    expect(onSignIn).not.toHaveBeenCalled();
  });

  test("the GitHub button needs no field filled", async () => {
    const onSignIn = mount(BOTH);
    fireEvent.click(button(/Continue with GitHub/));
    await tick();
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
    await tick();
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

describe("KeyGate", () => {
  test("greets the signed-in user and stores the key on submit", async () => {
    const fetchMock = stubFetch({ "PUT /studio/account/key": () => jsonResponse({ ok: true }) });
    const onSaved = vi.fn();
    renderWithClient(<KeyGate bearer="session-1" email="dev@local.test" onSaved={onSaved} />);

    expect(screen.getByText(/Signed in as dev@local\.test\./)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("AssemblyAI API key"), {
      target: { value: "aai-key" },
    });
    fireEvent.click(button("Open AssemblyAI Build"));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const [put] = fetchCallsWith(fetchMock, "PUT");
    expect(JSON.parse(String(put?.init.body))).toEqual({ apiKey: "aai-key" });
  });

  test("without an email it does not claim to know who is signed in", () => {
    renderWithClient(<KeyGate bearer="session-1" onSaved={vi.fn()} />);
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    expect(screen.getByText("Connect your AssemblyAI account")).toBeTruthy();
  });
});

describe("CliLinkGate", () => {
  const CODE = "abcd-efgh-ijkl";

  test("shows the confirmation code the terminal shows, before anything is granted", () => {
    const fetchMock = stubFetch({});
    renderWithClient(<CliLinkGate bearer="session-1" code={CODE} onDone={vi.fn()} />);
    expect(screen.getByText(linkConfirmationCode(CODE))).toBeTruthy();
    // Nothing is approved by opening the page.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("Link CLI approves this code, then offers the way back into the studio", async () => {
    const fetchMock = stubFetch({
      "POST /studio/cli-link/approve": () => jsonResponse({ ok: true }),
    });
    const onDone = vi.fn();
    renderWithClient(<CliLinkGate bearer="session-1" code={CODE} onDone={onDone} />);

    fireEvent.click(button("Link CLI"));
    expect(await screen.findByText("Terminal linked")).toBeTruthy();
    expect(JSON.parse(String(fetchCall(fetchMock).init.body))).toEqual({ code: CODE });

    fireEvent.click(button("Open AssemblyAI Build"));
    expect(onDone).toHaveBeenCalledOnce();
  });

  test("a refused approval says why and stays on the question", async () => {
    stubFetch({
      "POST /studio/cli-link/approve": () => jsonResponse({ error: "link code expired" }, 410),
    });
    renderWithClient(<CliLinkGate bearer="session-1" code={CODE} onDone={vi.fn()} />);

    fireEvent.click(button("Link CLI"));
    expect(await screen.findByText(/link code expired/)).toBeTruthy();
    expect(button("Link CLI").disabled).toBe(false);
  });

  test("Not now leaves without approving anything", () => {
    const fetchMock = stubFetch({});
    const onDone = vi.fn();
    renderWithClient(<CliLinkGate bearer="session-1" code={CODE} onDone={onDone} />);
    fireEvent.click(button("Not now"));
    expect(onDone).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
