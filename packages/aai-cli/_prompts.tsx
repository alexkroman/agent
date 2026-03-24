// Copyright 2025 the AAI authors. MIT license.

import { PasswordInput, TextInput } from "@inkjs/ui";
import { Box, render, Text } from "ink";
import { COLORS } from "./_ink.tsx";

/** Renders an Ink component that resolves a promise, then unmounts. */
function inkPrompt<T>(ui: (done: (value: T) => void) => React.JSX.Element): Promise<T> {
  return new Promise((resolve) => {
    const app = render(
      ui((value) => {
        resolve(value);
        app.unmount();
      }),
    );
  });
}

/**
 * Renders a password prompt, waits for the user to submit, and returns the value.
 * Creates and unmounts its own Ink instance — must not be called while another
 * Ink app is mounted.
 */
export function askPassword(message: string): Promise<string> {
  return inkPrompt((done) => (
    <Box>
      <Text>{message}: </Text>
      <PasswordInput onSubmit={done} />
    </Box>
  ));
}

/**
 * Renders a text input prompt with a default value and returns the submitted value.
 * Creates and unmounts its own Ink instance.
 */
export function askText(message: string, defaultValue: string): Promise<string> {
  return inkPrompt((done) => (
    <Box>
      <Text color={COLORS.interactive}>{message} › </Text>
      <TextInput placeholder={defaultValue} onSubmit={(value) => done(value || defaultValue)} />
    </Box>
  ));
}
