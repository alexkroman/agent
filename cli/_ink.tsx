// Copyright 2025 the AAI authors. MIT license.

import { Spinner, StatusMessage } from "@inkjs/ui";
import chalk from "chalk";
import { Box, render, Static, Text, useApp } from "ink";
import React, { useRef, useState } from "react";

// chalk's bundled supports-color bails when !streamIsTTY before checking
// COLORTERM/TERM. Running via tsx or npm scripts can break TTY detection,
// so we fall back to env vars when chalk detects level 0.
if (chalk.level === 0 && !process.env.NO_COLOR) {
  const ct = process.env.COLORTERM;
  if (ct === "truecolor" || ct === "24bit") {
    chalk.level = 3;
  } else if (ct || /-256(color)?$/i.test(process.env.TERM ?? "")) {
    chalk.level = 2;
  } else if (process.env.TERM_PROGRAM) {
    chalk.level = 1;
  }
}

/** Raw hex color constants for Ink `<Text color>` and chalk wrappers. */
export const COLORS = {
  primary: "#fab283",
  interactive: "#56b6c2",
  error: "#e06c75",
  warning: "#f5a742",
  success: "#7fd88f",
  accent: "#9d7cd8",
  muted: "#808080",
} as const;

/** Primary brand color — warm peach (chalk wrapper for plain strings). */
export function primary(s: string): string {
  return chalk.hex(COLORS.primary)(s);
}

/** Interactive/info color — cyan (chalk wrapper for plain strings). */
export function interactive(s: string): string {
  return chalk.hex(COLORS.interactive)(s);
}

/** Colored step message with a left-aligned bold action label. */
function StepBase({ action, msg, color }: { action: string; msg: string; color: string }) {
  return (
    <Text>
      <Text bold color={color}>
        {action}
      </Text>
      <Text> {msg}</Text>
    </Text>
  );
}

/** Primary step message with a left-aligned peach action label. */
export function Step({ action, msg }: { action: string; msg: string }) {
  return <StepBase action={action} msg={msg} color={COLORS.primary} />;
}

/** Informational step message with a left-aligned blue action label. */
export function StepInfo({ action, msg }: { action: string; msg: string }) {
  return <StepBase action={action} msg={msg} color={COLORS.interactive} />;
}

/** Dimmed info sub-line (indented to nest under a step). */
export function Info({ msg }: { msg: string }) {
  return (
    <Text dimColor>
      {"  "}
      {msg}
    </Text>
  );
}

/** Detail sub-line (indented to nest under a step). */
export function Detail({ msg }: { msg: string }) {
  return (
    <Text>
      {"  "}
      {msg}
    </Text>
  );
}

/** Yellow warning via @inkjs/ui StatusMessage. */
export function Warn({ msg }: { msg: string }) {
  return <StatusMessage variant="warning">{msg}</StatusMessage>;
}

/** Red error via @inkjs/ui StatusMessage. */
export function ErrorLine({ msg }: { msg: string }) {
  return <StatusMessage variant="error">{msg}</StatusMessage>;
}

/** An entry in a step log. */
export type StepEntry = { id: number; node: React.ReactNode };

/** Wrapper around Ink's `<Static>` for accumulated step output. */
export function StepLog({ items }: { items: StepEntry[] }) {
  return <Static items={items}>{(item) => <Box key={item.id}>{item.node}</Box>}</Static>;
}

/** Hook that manages a step log with auto-incrementing IDs. */
export function useStepLog() {
  const [items, setItems] = useState<StepEntry[]>([]);
  const nextId = useRef(0);

  const log = (node: React.ReactNode) => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { id, node }]);
  };

  return { items, log };
}

/** Helpers passed to the `run` callback of `CommandRunner` / `runWithInk`. */
export type RunHelpers = {
  /** Log a completed step (moves previous step to static output). */
  log: (node: React.ReactNode) => void;
  /** Set a live status line below the spinner (updates in place, not logged). */
  setStatus: (node: React.ReactNode | null) => void;
};

/**
 * Generic component that runs an async callback, logs steps via `<Static>`,
 * shows a spinner next to the current in-progress step, and exits when done.
 */
export function CommandRunner({
  run,
  onError,
}: {
  run: (helpers: RunHelpers) => Promise<void>;
  onError?: (err: Error) => void;
}) {
  const { exit } = useApp();
  const { items, log } = useStepLog();
  const [spinning, setSpinning] = useState(true);
  const [currentStep, setCurrentStep] = useState<React.ReactNode>(null);
  const [statusLine, setStatusLine] = useState<React.ReactNode>(null);
  const [err, setErr] = useState<string | null>(null);
  const currentStepRef = useRef<React.ReactNode>(null);

  const wrappedLog = (node: React.ReactNode) => {
    // Move the previous in-progress step to the completed log
    if (currentStepRef.current) {
      log(currentStepRef.current);
    }
    currentStepRef.current = node;
    setCurrentStep(node);
  };

  const started = useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        await run({ log: wrappedLog, setStatus: setStatusLine });
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        setErr(error.message);
        onError?.(error);
      }
      // Flush the last step to the completed log
      if (currentStepRef.current) {
        log(currentStepRef.current);
        currentStepRef.current = null;
      }
      setCurrentStep(null);
      setStatusLine(null);
      setSpinning(false);
      // Defer exit so React renders one more frame without the spinner
      setTimeout(() => exit(), 0);
    })();
  });

  return (
    <>
      <StepLog items={items} />
      {err && <ErrorLine msg={err} />}
      {spinning && currentStep && (
        <Box>
          <Spinner />
          <Text> </Text>
          {currentStep}
        </Box>
      )}
      {spinning && statusLine && <Box>{statusLine}</Box>}
    </>
  );
}

/**
 * Convenience wrapper: renders a `CommandRunner`, waits for exit,
 * and re-throws any error that occurred during execution.
 */
export async function runWithInk(fn: (helpers: RunHelpers) => Promise<void>): Promise<void> {
  let thrownError: Error | undefined;
  const app = render(
    <CommandRunner
      onError={(e) => {
        thrownError = e;
      }}
      run={fn}
    />,
  );
  await app.waitUntilExit();
  if (thrownError) process.exit(1);
}
