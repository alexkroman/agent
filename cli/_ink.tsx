/** @jsxImportSource react */
// Copyright 2025 the AAI authors. MIT license.

import { Spinner } from "@inkjs/ui";
import { Box, render, Static, Text, useApp } from "ink";
import React, { useRef, useState } from "react";

const PAD = 9;

const PRIMARY = "#fab283";
const INTERACTIVE = "#9dbefe";
const ERROR_COLOR = "#fc533a";
const WARNING_COLOR = "#fcd53a";

/** Primary step message with a right-aligned peach action label. */
export function Step({ action, msg }: { action: string; msg: string }) {
  return (
    <Text>
      <Text bold color={PRIMARY}>
        {action.padStart(PAD)}
      </Text>
      <Text> {msg}</Text>
    </Text>
  );
}

/** Informational step message with a right-aligned blue action label. */
export function StepInfo({ action, msg }: { action: string; msg: string }) {
  return (
    <Text>
      <Text bold color={INTERACTIVE}>
        {action.padStart(PAD)}
      </Text>
      <Text> {msg}</Text>
    </Text>
  );
}

/** Dimmed info line, indented to align with step message text. */
export function Info({ msg }: { msg: string }) {
  return (
    <Text dimColor>
      {" ".repeat(PAD + 1)}
      {msg}
    </Text>
  );
}

/** Indented line (same alignment as step/stepInfo message text) without dimming. */
export function Detail({ msg }: { msg: string }) {
  return (
    <Text>
      {" ".repeat(PAD + 1)}
      {msg}
    </Text>
  );
}

/** Yellow warning message. */
export function Warn({ msg }: { msg: string }) {
  return (
    <Text>
      <Text bold color={WARNING_COLOR}>
        {"warning".padStart(PAD)}
      </Text>
      <Text> {msg}</Text>
    </Text>
  );
}

/** Red error message. */
export function ErrorLine({ msg }: { msg: string }) {
  return (
    <Text>
      <Text bold color={ERROR_COLOR}>
        error
      </Text>
      <Text>: {msg}</Text>
    </Text>
  );
}

/** An entry in a step log. */
export type StepEntry = { id: number; node: React.ReactNode };

/** Wrapper around Ink's `<Static>` for accumulated step output. */
export function StepLog({ items }: { items: StepEntry[] }) {
  return <Static items={items}>{(item) => <Box key={item.id}>{item.node}</Box>}</Static>;
}

/** Spinner with label text, indented to align with step messages. */
export function TaskSpinner({ label }: { label: string }) {
  return (
    <Box>
      <Text>{" ".repeat(PAD + 1)}</Text>
      <Spinner label={label} />
    </Box>
  );
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

/**
 * Generic component that runs an async callback, logs steps via `<Static>`,
 * shows a spinner while running, and exits when done.
 */
export function CommandRunner({
  run,
  spinnerLabel,
  onError,
}: {
  run: (log: (node: React.ReactNode) => void) => Promise<void>;
  spinnerLabel?: string;
  onError?: (err: Error) => void;
}) {
  const { exit } = useApp();
  const { items, log } = useStepLog();
  const [spinning, setSpinning] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const started = useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        await run(log);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        setErr(error.message);
        onError?.(error);
      }
      setSpinning(false);
      exit();
    })();
  });

  return (
    <>
      <StepLog items={items} />
      {err && <ErrorLine msg={err} />}
      {spinning && <TaskSpinner label={spinnerLabel ?? ""} />}
    </>
  );
}

/**
 * Convenience wrapper: renders a `CommandRunner`, waits for exit,
 * and re-throws any error that occurred during execution.
 */
export async function runWithInk(
  label: string,
  fn: (log: (node: React.ReactNode) => void) => Promise<void>,
): Promise<void> {
  let thrownError: Error | undefined;
  const app = render(
    <CommandRunner
      spinnerLabel={label}
      onError={(e) => {
        thrownError = e;
      }}
      run={fn}
    />,
  );
  await app.waitUntilExit();
  if (thrownError) throw thrownError;
}
