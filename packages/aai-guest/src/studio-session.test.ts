// Copyright 2026 the AAI authors. MIT license.
/**
 * What a studio session IS: the prompt section only the guest can write, and
 * the two claims `initStudioSession` makes about a re-install.
 *
 * The re-install claim is the module's own headline — a refresh or a second
 * tab sends `studio/session-init` to a LIVE sandbox, and the reset that call
 * begins with is an `rm -rf` of a path constant per process, i.e. of the very
 * directory an in-flight turn's tools have closed over. So a session-init that
 * cannot claim the turn gate must keep the tree and take only the new config,
 * and it must NOT pin this sandbox's identity, because no install happened.
 *
 * UNIT tier, and the mid-turn path is what makes that possible: it returns
 * before `materializeWorkspace`, so this file writes nothing and spawns
 * nothing. The install path proper (materialize, project shape, `npm
 * install`) is exercised against a real filesystem by
 * `studio-session-init.test.ts`.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { workspacesRoot } from "./studio-build.ts";
import {
  initStudioSession,
  resetSessionIdentity,
  SessionIdentityError,
  type StudioSessionParams,
  toolchainPromptSection,
} from "./studio-session.ts";
import { enterTurn, resetTurnGate } from "./studio-turn-stream.ts";

const params = (over: Partial<StudioSessionParams> = {}): StudioSessionParams => ({
  scope: "scope-a",
  project: "proj-a",
  files: { "agent.ts": "// v1" },
  apiKey: "caller-key",
  chatToken: "chat-token",
  system: "You are a coding agent.",
  model: "fake-1",
  maxSteps: 4,
  ...over,
});

describe("toolchainPromptSection", () => {
  test("says nothing when no toolchain was found", () => {
    // The harness sits at a different depth in the Modal image and under the
    // subprocess backend, so an absent toolchain is a real state — and half a
    // section naming paths that are not there is worse than none.
    expect(toolchainPromptSection(null)).toBe("");
  });

  test("names every path it advertises, absolutely and under the modules dir", () => {
    const modules = path.join(path.sep, "opt", "aai", "node_modules");
    const section = toolchainPromptSection(modules);
    for (const rel of [
      path.join("@alexkroman1", "aai-cli", "dist", "templates"),
      path.join("@alexkroman1", "aai", "dist"),
      path.join("@alexkroman1", "aai-ui", "dist", "index.d.ts"),
      path.join("@alexkroman1", "aai-ui", "dist", "components"),
    ]) {
      expect(section).toContain(path.join(modules, rel));
    }
    // Absolute is the one form that survives a `bash` call with an unexpected
    // cwd, and `bash` is the only tool that can reach outside the workspace.
    for (const quoted of section.match(/`[^`]+`/g) ?? []) {
      const inner = quoted.slice(1, -1);
      if (inner.includes(path.sep) && inner.includes("@alexkroman1")) {
        expect(path.isAbsolute(inner)).toBe(true);
      }
    }
    // It names the tools that can and cannot see these files, because that is
    // the mistake the section exists to prevent.
    expect(section).toContain("bash");
    expect(section).toContain("read_file");
  });
});

describe("SessionIdentityError", () => {
  test("names both identities, so a 409 says which sandbox refused what", () => {
    const err = new SessionIdentityError(
      { scope: "scope-a", project: "proj-a" },
      { scope: "scope-b", project: "proj-b" },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionIdentityError");
    expect(err.message).toContain("scope-a/proj-a");
    expect(err.message).toContain("scope-b/proj-b");
  });
});

describe("initStudioSession while a turn is in flight", () => {
  let release: (() => void) | null = null;

  beforeEach(() => {
    resetSessionIdentity();
    resetTurnGate();
    // Take the process-wide claim the way a chat turn does, and hold it for
    // the whole test: this is the state a refresh or a second tab arrives in.
    // A throw rather than an `expect`: an assertion outside a test body is
    // not reported as one, and this is setup, not the claim.
    release = enterTurn();
    if (!release) throw new Error("the turn gate was already held at test start");
  });

  afterEach(() => {
    release?.();
    release = null;
    resetTurnGate();
    resetSessionIdentity();
  });

  test("keeps the live tree and takes only the new config", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = await initStudioSession(
      params({ chatToken: "fresh-token", model: "fake-2", system: "New prompt." }),
    );
    // The same per-process path the running turn's tools closed over — the
    // session is re-POINTED at the live tree, never given a new one.
    expect(session.dir).toBe(path.join(workspacesRoot(), "session"));
    expect(session.chatToken).toBe("fresh-token");
    expect(session.model).toBe("fake-2");
    // The guest's own prompt section is appended either way: the tab that
    // asked for the install still gets a usable session.
    expect(session.system.startsWith("New prompt.")).toBe(true);
    expect(session.system).toBe(`New prompt.${toolchainPromptSection()}`);
    // Out loud: a kept tree is a decision, and a silent one reads as a reset.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("keeping the live workspace"));
  });

  test("does not brand the sandbox with an identity it never installed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await initStudioSession(params({ scope: "scope-a", project: "proj-a" }));
    // Nothing was materialized, so nothing was served — a later install for a
    // different project must still be allowed to pin this guest. (Pinning on
    // a path that touched no disk is how a rejected first install would brand
    // a sandbox with an identity it never had.)
    await expect(
      initStudioSession(params({ scope: "scope-b", project: "proj-b" })),
    ).resolves.toMatchObject({ scope: "scope-b", project: "proj-b" });
  });
});
