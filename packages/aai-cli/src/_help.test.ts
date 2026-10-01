// Copyright 2026 the AAI authors. MIT license.
/**
 * `_help.ts`: the grouped root `--help`. That the sections cover exactly the
 * REGISTERED commands is `cli.test.ts`'s (it owns the command tree); this is
 * the renderer and the section data.
 */
import { stripVTControlCharacters } from "node:util";
import { describe, expect, test } from "vitest";
import { BARE_AAI_HELP, HELP_SECTIONS, renderRootHelp } from "./_help.ts";

const plain = (s: string): string => stripVTControlCharacters(s);

/** Every command the sections name, each with a description. */
const ALL = Object.fromEntries(
  HELP_SECTIONS.flatMap((s) => s.commands).map((name) => [name, `does ${name}`]),
);

const render = (commands: Record<string, string> = ALL): string =>
  plain(renderRootHelp({ description: "Voice agent development kit", version: "1.2.3", commands }));

describe("HELP_SECTIONS", () => {
  test("names the sections the request asked for, in order, no command twice", () => {
    expect(HELP_SECTIONS.map((s) => s.commands)).toEqual([
      ["init", "dev", "console", "test", "eval", "build"],
      ["pull", "push", "publish", "delete", "list"],
      ["logs", "secret", "workflow"],
      ["start"],
      ["login"],
      ["templates"],
    ]);
    const placed = HELP_SECTIONS.flatMap((s) => s.commands);
    expect(new Set(placed).size).toBe(placed.length);
  });
});

describe("renderRootHelp", () => {
  test("prints every command once, under its section heading, in section order", () => {
    const help = render();
    for (const [name, description] of Object.entries(ALL)) {
      expect(help.match(new RegExp(`^  ${name} +${description}$`, "gm"))).toHaveLength(1);
    }
    const headings = HELP_SECTIONS.map((s) => help.indexOf(s.title.toUpperCase()));
    expect(headings).not.toContain(-1);
    expect([...headings].sort((x, y) => x - y)).toEqual(headings);
    expect(help).toContain("Voice agent development kit (aai v1.2.3)");
  });

  test("says that a bare `aai` in an agent directory publishes to production", () => {
    const help = render();
    for (const line of BARE_AAI_HELP) expect(help).toContain(line);
    expect(help).toMatch(/PRODUCTION/);
  });

  test("a command no section names lands under OTHER rather than vanishing", () => {
    const help = render({ ...ALL, brandnew: "a new command" });
    expect(help).toMatch(/OTHER\n\n {2}brandnew +a new command/);
    expect(render()).not.toContain("OTHER");
  });

  test("a section whose commands are all absent is left out", () => {
    const { login: _login, ...rest } = ALL;
    expect(render(rest)).not.toContain("ACCOUNT");
  });
});
