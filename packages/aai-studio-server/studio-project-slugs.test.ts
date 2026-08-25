// Copyright 2026 the AAI authors. MIT license.
/**
 * What a project's two agents are CALLED (studio-project-slugs.ts) — the
 * stamped production/preview pair, and the name a preview claims when it has
 * none yet.
 */

import { VALID_SLUG_RE } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { previewSlugFor, projectSlugFor } from "./studio-project-slugs.ts";
import type { StudioWorkspace } from "./studio-workspace.ts";

const workspace = (extra: Partial<StudioWorkspace> = {}): StudioWorkspace => ({
  files: {},
  hash: "h",
  updatedAt: 0,
  ...extra,
});

describe("projectSlugFor", () => {
  test("reads each environment's own stamp", () => {
    const ws = workspace({ deployedSlug: "proj", previewSlug: "proj-preview" });
    expect(projectSlugFor(ws, "production")).toBe("proj");
    expect(projectSlugFor(ws, "preview")).toBe("proj-preview");
  });

  test("an environment that has never deployed has no slug", () => {
    expect(projectSlugFor(workspace(), "production")).toBeUndefined();
    expect(projectSlugFor(workspace(), "preview")).toBeUndefined();
  });
});

describe("previewSlugFor", () => {
  test("appends -preview to the project name", () => {
    expect(previewSlugFor("contact-form-x7k2mq")).toBe("contact-form-x7k2mq-preview");
  });

  test("a name that exactly fits is not shortened", () => {
    // 56 chars + "-preview" is exactly the 64-character maximum.
    const exact = "a".repeat(56);
    expect(previewSlugFor(exact)).toBe(`${exact}-preview`);
    expect(previewSlugFor(exact)).toHaveLength(64);
  });

  test("a shortened slug still fits the platform's slug shape", () => {
    const slug = previewSlugFor(`a${"b".repeat(70)}`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(VALID_SLUG_RE.test(slug)).toBe(true);
    expect(slug.endsWith("-preview")).toBe(true);
    // Never a double separator at the shortening point.
    expect(slug).not.toContain("--");
  });

  test("trims trailing separators left by the cut", () => {
    // The 47th character is a separator, so the digest must not join onto it.
    expect(previewSlugFor(`${"x".repeat(46)}-${"y".repeat(20)}`)).toMatch(
      /^x{46}-[0-9a-f]{8}-preview$/,
    );
  });

  /**
   * The finding this function was rewritten for: `ProjectNameSchema` admits 64
   * characters and the old truncation kept 56, so two long names that agreed
   * on their first 56 reduced to ONE preview slug — both deploys succeeding
   * (same account, so no ownership 409), both stamping their own
   * `previewHash`, and one agent serving both projects' Preview panes with no
   * error anywhere.
   */
  test("two long names that share a prefix get DIFFERENT preview slugs", () => {
    const shared = "p".repeat(56);
    const alpha = previewSlugFor(`${shared}-alpha`);
    const beta = previewSlugFor(`${shared}-beta`);
    expect(alpha).not.toBe(beta);
    expect(VALID_SLUG_RE.test(alpha)).toBe(true);
    expect(VALID_SLUG_RE.test(beta)).toBe(true);
  });

  test("shortening is deterministic — the same name always maps to one slug", () => {
    const name = `${"q".repeat(56)}-tail`;
    expect(previewSlugFor(name)).toBe(previewSlugFor(name));
  });
});
