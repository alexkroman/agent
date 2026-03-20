// Copyright 2025 the AAI authors. MIT license.
import chalk from "chalk";
import { interactive, primary } from "./_colors.ts";

/** Definition of a CLI option flag for help text rendering. */
export interface OptionDef {
  /** Flag syntax string (e.g. `"-s, --server <url>"`). */
  flags: string;
  /** Human-readable description of the option. */
  description: string;
  /** If `true`, the option is omitted from help output. */
  hidden?: boolean;
}

/** Definition of a CLI subcommand used to generate help text. */
export interface SubcommandDef {
  /** Subcommand name (e.g. `"new"`, `"deploy"`). */
  name: string;
  /** Short description shown in help output. */
  description: string;
  /** Positional arguments accepted by the subcommand. */
  args?: { name: string; optional?: boolean }[];
  /** Option flags accepted by the subcommand. */
  options?: OptionDef[];
}

/**
 * Generates the top-level `aai --help` output with ASCII logo, available
 * commands, global options, and a getting-started example.
 *
 * @param version The current CLI version string.
 * @returns Formatted, colorized help text.
 */
export function rootHelp(version: string): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(
    `  ${primary(chalk.bold(" ▄▀█ ▄▀█ █"))}   ${chalk.dim("Voice agent development kit")}`,
  );
  lines.push(`  ${primary(chalk.bold(" █▀█ █▀█ █"))}   ${primary(`v${version}`)}`);
  lines.push("");
  lines.push(
    `  ${chalk.bold(interactive("Usage"))}   ${primary("aai")} ${chalk.dim("<command> [options]")}`,
  );
  lines.push("");
  lines.push(`  ${chalk.bold(interactive("Commands"))}`);
  lines.push("");

  const cmds: [string, string, string][] = [
    ["init", "[dir]", "Scaffold a new agent project"],
    ["dev", "", "Start a local development server"],
    ["build", "", "Bundle and validate (no server or deploy)"],
    ["deploy", "", "Bundle and deploy to production"],
    ["start", "", "Start production server from build"],
    ["secret", "<cmd>", "Manage secrets"],
    ["rag", "<url>", "Ingest a site into the vector store"],
  ];

  for (const [name, args, desc] of cmds) {
    const nameStr = interactive(name.padEnd(8));
    const argsStr = args ? primary(args.padEnd(6)) : "      ";
    lines.push(`    ${nameStr} ${argsStr} ${chalk.dim(desc)}`);
  }

  lines.push("");
  lines.push(`  ${chalk.bold(interactive("Options"))}`);
  lines.push("");
  lines.push(
    `    ${interactive("-h")}${chalk.dim(",")} ${interactive("--help")}      ${chalk.dim(
      "Show this help",
    )}`,
  );
  lines.push(
    `    ${interactive("-V")}${chalk.dim(",")} ${interactive("--version")}   ${chalk.dim(
      "Show the version number",
    )}`,
  );
  lines.push("");
  lines.push(`  ${chalk.bold(interactive("Getting started"))}`);
  lines.push("");
  lines.push(`    ${chalk.dim("$")} ${primary("aai init")} ${interactive("my-agent")}`);
  lines.push(`    ${chalk.dim("$")} ${primary("cd")} ${interactive("my-agent")}`);
  lines.push(`    ${chalk.dim("$")} ${primary("aai dev")}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Generates help text for a specific subcommand, listing its arguments,
 * options, and descriptions.
 *
 * @param cmd The subcommand definition to render help for.
 * @param version The current CLI version string.
 * @returns Formatted, colorized help text.
 */
export function subcommandHelp(cmd: SubcommandDef, version: string): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(
    `  ${primary(chalk.bold("aai"))} ${interactive(chalk.bold(cmd.name))}${
      version ? chalk.dim(`  v${version}`) : ""
    }`,
  );
  lines.push(`  ${chalk.dim(cmd.description)}`);
  lines.push("");

  if (cmd.args && cmd.args.length > 0) {
    lines.push(`  ${chalk.bold(interactive("Arguments"))}`);
    lines.push("");
    for (const arg of cmd.args) {
      const label = arg.optional ? primary(`[${arg.name}]`) : primary(`<${arg.name}>`);
      lines.push(`    ${label}`);
    }
    lines.push("");
  }

  const visibleOptions = (cmd.options ?? []).filter((o) => !o.hidden);
  if (visibleOptions.length > 0) {
    lines.push(`  ${chalk.bold(interactive("Options"))}`);
    lines.push("");
    for (const opt of visibleOptions) {
      lines.push(`    ${interactive(opt.flags)}`);
      lines.push(`      ${chalk.dim(opt.description)}`);
    }

    lines.push(`    ${interactive("-h")}${chalk.dim(",")} ${interactive("--help")}`);
    lines.push(`      ${chalk.dim("Show this help")}`);
    lines.push("");
  }

  return lines.join("\n");
}
