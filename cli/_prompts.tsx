/** @jsxImportSource react */
// Copyright 2025 the AAI authors. MIT license.

import { ConfirmInput, PasswordInput, Select, TextInput } from "@inkjs/ui";
import { Box, render, Text } from "ink";
import { COLORS } from "./_colors.ts";

/**
 * Renders a password prompt, waits for the user to submit, and returns the value.
 * Creates and unmounts its own Ink instance — must not be called while another
 * Ink app is mounted.
 */
export async function askPassword(message: string): Promise<string> {
  return new Promise((resolve) => {
    const app = render(
      <Box>
        <Text>{message}: </Text>
        <PasswordInput
          onSubmit={(value) => {
            resolve(value);
            app.unmount();
          }}
        />
      </Box>,
    );
  });
}

/**
 * Renders a Y/N confirmation prompt and returns the result.
 * Creates and unmounts its own Ink instance.
 */
export async function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const app = render(
      <Box>
        <Text>{message} </Text>
        <ConfirmInput
          onConfirm={() => {
            resolve(true);
            app.unmount();
          }}
          onCancel={() => {
            resolve(false);
            app.unmount();
          }}
        />
      </Box>,
    );
  });
}

/**
 * Renders a text input prompt with a default value and returns the submitted value.
 * Creates and unmounts its own Ink instance.
 */
export async function askText(message: string, defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    const app = render(
      <Box>
        <Text color={COLORS.interactive}>{message} › </Text>
        <TextInput
          placeholder={defaultValue}
          onSubmit={(value) => {
            resolve(value || defaultValue);
            app.unmount();
          }}
        />
      </Box>,
    );
  });
}

/** A choice for the `askSelect` prompt. */
export type SelectChoice = { label: string; value: string };

/**
 * Renders an arrow-key selection menu and returns the chosen value.
 * Creates and unmounts its own Ink instance.
 */
export async function askSelect(message: string, choices: SelectChoice[]): Promise<string> {
  return new Promise((resolve) => {
    const app = render(
      <Box flexDirection="column">
        <Text>{message}</Text>
        <Select
          options={choices}
          visibleOptionCount={choices.length}
          onChange={(value) => {
            resolve(value);
            app.unmount();
          }}
        />
      </Box>,
    );
  });
}
