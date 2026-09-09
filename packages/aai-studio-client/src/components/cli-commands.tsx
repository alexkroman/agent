// Copyright 2026 the AAI authors. MIT license.
// "Work locally" — the `aai` CLI commands that pull this studio project onto
// a machine, each with its own copy button. The studio has no download and
// the CLI round-trip is not discoverable from the UI otherwise, so the
// commands are spelled out with the project name already filled in.

import { useCopy } from "@alexkroman1/aai-ui";
import { CopyLine } from "./snippet.tsx";

const CLI_PACKAGE = "@alexkroman1/aai-cli";

/**
 * The commands that put this project on a laptop, in order.
 *
 * No `--server`: the CLI targets its own shipped default origin, which is the
 * platform these commands are copied from. A studio served from anywhere else
 * (local dev, a preview deploy) needs the flag added by hand — passing it is
 * also what approves a non-default origin for credentialed requests (see
 * `resolveServerUrl` in aai-cli/_agent.ts). `aai pull` writes the origin into
 * the pulled project's `.aai/project.json`, so `push` and `publish` never
 * needed the flag afterwards either.
 */
export function pullCommands(project: string): string[] {
  return [
    `npm i -g ${CLI_PACKAGE}`,
    "aai login",
    `aai pull ${project}`,
    `cd ${project} && aai dev`,
  ];
}

type CliCommandsProps = {
  /** The open project's name — `aai pull`'s argument and the target directory. */
  project: string;
};

export function CliCommands({ project }: CliCommandsProps) {
  const commands = pullCommands(project);
  const copier = useCopy();

  const all = commands.join("\n");

  // Heading and blurb belong to the Settings page's section card — this
  // renders the commands themselves and nothing else.
  return (
    <div className="flex flex-col gap-3">
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {commands.map((command) => (
          <li key={command}>
            <CopyLine text={command} label={`Copy: ${command}`} copier={copier} />
          </li>
        ))}
      </ol>
      <button type="button" className="btn self-start" onClick={() => copier.copy(all)}>
        {copier.didCopy(all) ? "Copied all" : "Copy all"}
      </button>
    </div>
  );
}
