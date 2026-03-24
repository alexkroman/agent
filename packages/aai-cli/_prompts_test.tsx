// Copyright 2025 the AAI authors. MIT license.
import { PasswordInput, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";
import { COLORS } from "./_ink.tsx";

describe("askText prompt", () => {
  function renderTextPrompt(message: string, defaultValue: string, onSubmit: (v: string) => void) {
    return render(
      <Box>
        <Text color={COLORS.interactive}>{message} › </Text>
        <TextInput
          placeholder={defaultValue}
          onSubmit={(value) => onSubmit(value || defaultValue)}
        />
      </Box>,
    );
  }

  test("displays the prompt message", () => {
    const { lastFrame } = renderTextPrompt(
      "What is your project named?",
      "my-voice-agent",
      () => {},
    );
    expect(lastFrame()).toContain("What is your project named?");
  });

  test("submits typed text on Enter", async () => {
    let submitted: string | undefined;
    const { stdin } = renderTextPrompt("Project name", "default", (v) => {
      submitted = v;
    });

    stdin.write("my-cool-agent");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(submitted).toBe("my-cool-agent");
  });

  test("submits default value when Enter pressed with no input", async () => {
    let submitted: string | undefined;
    const { stdin } = renderTextPrompt("Project name", "my-voice-agent", (v) => {
      submitted = v;
    });

    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(submitted).toBe("my-voice-agent");
  });
});

describe("askPassword prompt", () => {
  function renderPasswordPrompt(message: string, onSubmit: (v: string) => void) {
    return render(
      <Box>
        <Text>{message}: </Text>
        <PasswordInput onSubmit={onSubmit} />
      </Box>,
    );
  }

  test("displays the prompt message", () => {
    const { lastFrame } = renderPasswordPrompt("ASSEMBLYAI_API_KEY", () => {});
    expect(lastFrame()).toContain("ASSEMBLYAI_API_KEY");
  });

  test("submits typed password on Enter", async () => {
    let submitted: string | undefined;
    const { stdin } = renderPasswordPrompt("ASSEMBLYAI_API_KEY", (v) => {
      submitted = v;
    });

    stdin.write("sk-1234567890abcdef");
    await new Promise((r) => setTimeout(r, 50));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 50));

    expect(submitted).toBe("sk-1234567890abcdef");
  });

  test("masks input in rendered output", async () => {
    const { stdin, lastFrame } = renderPasswordPrompt("API Key", () => {});

    stdin.write("secret");
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).not.toContain("secret");
  });
});
