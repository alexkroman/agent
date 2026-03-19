// Copyright 2025 the AAI authors. MIT license.

import { Spinner } from "@inkjs/ui";
import { Box, render, Static, Text, useApp } from "ink";
import React, { useRef, useState } from "react";

import { COLORS } from "./_colors.ts";

/** Primary step message with a left-aligned peach action label. */
export function Step({ action, msg }: { action: string; msg: string }) {
  return (
    <Text>
      <Text bold color={COLORS.primary}>
        {action}
      </Text>
      <Text> {msg}</Text>
    </Text>
  );
}

/** Informational step message with a left-aligned blue action label. */
export function StepInfo({ action, msg }: { action: string; msg: string }) {
  return (
    <Text>
      <Text bold color={COLORS.interactive}>
        {action}
      </Text>
      <Text> {msg}</Text>
    </Text>
  );
}

/** Dimmed info line. */
export function Info({ msg }: { msg: string }) {
  return <Text dimColor>{msg}</Text>;
}

/** Detail line without dimming. */
export function Detail({ msg }: { msg: string }) {
  return <Text>{msg}</Text>;
}

/** Yellow warning message. */
export function Warn({ msg }: { msg: string }) {
  return (
    <Text>
      <Text bold color={COLORS.warning}>
        warning
      </Text>
      <Text> {msg}</Text>
    </Text>
  );
}

/** Red error message. */
export function ErrorLine({ msg }: { msg: string }) {
  return (
    <Text>
      <Text bold color={COLORS.error}>
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
 * shows a spinner next to the current in-progress step, and exits when done.
 */
export function CommandRunner({
  run,
  onError,
}: {
  run: (log: (node: React.ReactNode) => void) => Promise<void>;
  onError?: (err: Error) => void;
}) {
  const { exit } = useApp();
  const { items, log } = useStepLog();
  const [spinning, setSpinning] = useState(true);
  const [currentStep, setCurrentStep] = useState<React.ReactNode>(null);
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
        await run(wrappedLog);
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
    </>
  );
}

/**
 * Convenience wrapper: renders a `CommandRunner`, waits for exit,
 * and re-throws any error that occurred during execution.
 */
export async function runWithInk(
  fn: (log: (node: React.ReactNode) => void) => Promise<void>,
): Promise<void> {
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
  if (thrownError) throw thrownError;
}
