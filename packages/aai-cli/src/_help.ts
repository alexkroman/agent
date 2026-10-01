// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai --help`: the root usage, grouped by what a command acts on.
 *
 * citty renders one flat COMMANDS list, which put `publish` (production) next
 * to `dev` (this machine) with nothing to tell them apart. The grouping is DATA
 * here and `cli.test.ts` requires every visible subcommand in exactly one
 * section, so a new command cannot silently fall out of the help.
 */

import { styleText } from "node:util";
import type { ArgsDef, CommandDef } from "citty";

/** One help section: a heading and the subcommands under it, in display order. */
export type HelpSection = { readonly title: string; readonly commands: readonly string[] };

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    title: "Local development (this machine)",
    commands: ["init", "dev", "console", "test", "eval", "build"],
  },
  {
    title: "Studio round-trip (source ↔ the studio workspace)",
    commands: ["pull", "push", "publish", "delete", "list"],
  },
  { title: "Deployed agent", commands: ["logs", "secret", "workflow"] },
  { title: "Self-hosting", commands: ["start"] },
  { title: "Account", commands: ["login"] },
  { title: "Templates", commands: ["templates"] },
];

/**
 * What a bare `aai` does — the one implicit command, and the one that reaches
 * production, so it is said in the help rather than left to be discovered.
 */
export const BARE_AAI_HELP = [
  "With no command, `aai` in an agent directory (one with agent.ts) runs `aai publish`:",
  "it pushes to the studio and deploys to PRODUCTION. At a terminal it asks first;",
  "a non-interactive run publishes without asking. Elsewhere it runs `aai init`.",
];

const heading = (text: string): string => styleText(["bold", "underline"], text);

/** Resolve a citty `Resolvable` field (a value, a promise, or a thunk of either). */
async function resolved<T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}

/** `aai --help` for `root`: every visible subcommand, grouped. */
export async function rootHelp(root: CommandDef<ArgsDef>): Promise<string> {
  const meta = (await resolved(root.meta)) ?? {};
  const commands: Record<string, string> = {};
  for (const [name, sub] of Object.entries((await resolved(root.subCommands)) ?? {})) {
    const subMeta = await resolved((await resolved(sub)).meta);
    if (subMeta?.hidden) continue;
    commands[name] = subMeta?.description ?? "";
  }
  return renderRootHelp({
    description: meta.description ?? "",
    version: meta.version ?? "unknown",
    commands,
  });
}

/**
 * The root usage text. `commands` is every VISIBLE subcommand's description,
 * keyed by name; one no section names lands under "Other" rather than vanish.
 */
export function renderRootHelp(opts: {
  description: string;
  version: string;
  commands: Readonly<Record<string, string>>;
}): string {
  const names = Object.keys(opts.commands);
  const width = Math.max(...names.map((n) => n.length)) + 2;
  const row = (name: string): string =>
    `  ${styleText("cyan", name.padEnd(width))}${opts.commands[name] ?? ""}`;
  const placed = new Set(HELP_SECTIONS.flatMap((s) => s.commands));
  const other = names.filter((n) => !placed.has(n));
  const sections = [
    ...HELP_SECTIONS,
    ...(other.length > 0 ? [{ title: "Other", commands: other }] : []),
  ];

  const lines = [
    styleText("gray", `${opts.description} (aai v${opts.version})`),
    "",
    `${heading("USAGE")} ${styleText("cyan", "aai <command> [OPTIONS]")}`,
    "",
  ];
  for (const section of sections) {
    const rows = section.commands.filter((n) => n in opts.commands).map(row);
    if (rows.length === 0) continue;
    lines.push(heading(section.title.toUpperCase()), "", ...rows, "");
  }
  lines.push(...BARE_AAI_HELP, "");
  lines.push(
    `Use ${styleText("cyan", "aai <command> --help")} for more information about a command.`,
  );
  return lines.join("\n");
}
