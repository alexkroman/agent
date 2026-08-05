// Copyright 2026 the AAI authors. MIT license.
// "Work locally" — the `aai` CLI commands that pull this studio project onto
// a machine, each with its own copy button. The studio has no download and
// the CLI round-trip is not discoverable from the UI otherwise, so the
// commands are spelled out with the project name already filled in.

import { useEffect, useRef, useState } from "react";

const CLI_PACKAGE = "@alexkroman1/aai-cli";

/**
 * The commands that put this project on a laptop, in order.
 *
 * `--server` is always spelled out rather than left implicit. The CLI targets
 * its own shipped default origin when the flag is absent, and passing the flag
 * is ALSO what approves an origin for credentialed requests (see
 * `resolveServerUrl` in aai-cli/_agent.ts) — so a studio served from anywhere
 * else needs it on both the login and the pull. The client cannot compare
 * against the CLI's default without importing from aai-cli, which would widen
 * the package boundary, so the flag is emitted unconditionally: correct
 * everywhere, at the cost of one long line in the common case. `aai pull`
 * writes the origin into the pulled project's `.aai/project.json`, so `push`
 * and `publish` need no flag afterwards.
 */
export function pullCommands(project: string, origin: string): string[] {
  return [
    `npm i -g ${CLI_PACKAGE}`,
    `aai login --server ${origin}`,
    `aai pull ${project} --server ${origin}`,
    `cd ${project} && aai dev`,
  ];
}

type CopyState = { text: string; ok: boolean };

type CliCommandsProps = {
  /** The open project's name — `aai pull`'s argument and the target directory. */
  project: string;
  /** The studio's own origin. Injected for tests; defaults to this page's. */
  origin?: string;
};

export function CliCommands({ project, origin }: CliCommandsProps) {
  const commands = pullCommands(project, origin ?? window.location.origin);
  const [copied, setCopied] = useState<CopyState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // One live timer at a time, and none after unmount.
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = (text: string) => {
    const flash = (ok: boolean) => {
      setCopied({ text, ok });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1500);
    };
    // No clipboard in an insecure context (and none in jsdom) — the commands
    // are on screen either way, so a failure only changes the button label.
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      flash(false);
      return;
    }
    void write.then(
      () => flash(true),
      () => flash(false),
    );
  };

  const label = (text: string) => {
    if (copied?.text !== text) return "Copy";
    return copied.ok ? "Copied" : "Failed";
  };

  const all = commands.join("\n");

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="eyebrow">Work locally</span>
      <p className="m-0 text-[13px] leading-5 text-muted">
        Pull this project's files with the <code className="font-mono">aai</code> CLI, edit them in
        your own editor, then <code className="font-mono">aai push</code> to sync them back (or{" "}
        <code className="font-mono">aai publish</code> to sync and ship to production).
      </p>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {commands.map((command) => (
          <li key={command} className="flex items-center gap-2">
            <code className="min-w-0 flex-1 rounded-md border border-line bg-cream px-2 py-1 font-mono text-[11px] break-all">
              {command}
            </code>
            <button
              type="button"
              className="btn px-2 py-1 text-xs"
              onClick={() => copy(command)}
              aria-label={`Copy: ${command}`}
            >
              {label(command)}
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="btn self-start" onClick={() => copy(all)}>
        {copied?.text === all && copied.ok ? "Copied all" : "Copy all"}
      </button>
    </div>
  );
}
