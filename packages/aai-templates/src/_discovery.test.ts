// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />

import { existsSync } from "node:fs";
import path from "node:path";
import { agent, DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { templatePromptFiles, withTemplatePrompt, withTemplateTools } from "./_discovery.ts";
import { byCodeUnit } from "./_template-support.ts";

/** Every template's directory name, from a glob independent of the one under test. */
const templates = Object.keys(import.meta.glob("../templates/*/agent.ts"))
  .map((modulePath) => modulePath.split("/")[2] ?? "")
  .sort(byCodeUnit)
  .map((name) => ({ name }));

describe("template discovery", () => {
  /**
   * The prompt glob is checked against the FILESYSTEM, not against itself.
   *
   * `withTemplatePrompt` no-ops for a template with no `system-prompt.md`, so a
   * glob that stopped resolving would make every template look like that case
   * and the per-template assertion below would skip silently. A first attempt at
   * this guard derived the expected set from the same glob and was verified
   * NOT to bite: breaking the pattern changed nothing. Two independent sources
   * is the only shape that can catch it.
   */
  test("every system-prompt.md on disk is discovered", () => {
    const onDisk = templates
      .filter(({ name }) =>
        existsSync(path.join(import.meta.dirname, "..", "templates", name, "system-prompt.md")),
      )
      .map(({ name }) => name);
    expect(onDisk.length).toBeGreaterThan(0);
    expect([...templatePromptFiles].toSorted()).toEqual(onDisk.toSorted());
  });

  test("withTemplateTools attaches exactly the template's own tools/ files", () => {
    const def = withTemplateTools("coding-agent", agent({ name: "probe" }));
    expect(Object.keys(def.tools ?? {})).toEqual(
      expect.arrayContaining(["read_file", "write_file", "bash"]),
    );
  });

  test("a template with no tools/ directory resolves with no tools", () => {
    const def = withTemplateTools("transcription-workflow", agent({ name: "probe" }));
    expect(Object.keys(def.tools ?? {})).toEqual([]);
  });

  test("withTemplatePrompt applies a discovered file and leaves the rest alone", () => {
    const [withFile] = [...templatePromptFiles];
    if (withFile === undefined) throw new Error("no template keeps a system-prompt.md");
    expect(withTemplatePrompt(withFile, agent({ name: "probe" })).systemPrompt).not.toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
    const plain = agent({ name: "probe" });
    expect(withTemplatePrompt("no-such-template", plain)).toBe(plain);
  });
});
