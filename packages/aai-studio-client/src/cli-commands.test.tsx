// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings panel's "Work locally" section: the CLI commands that pull a
// studio project onto a machine. The project name has to reach `aai pull`
// and the `cd`, and the studio's own origin has to reach `--server` — a
// command that copies cleanly but targets the wrong server is the failure
// mode this section exists to prevent.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CliCommands, pullCommands } from "./cli-commands.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ORIGIN = "https://studio.example";

describe("pullCommands", () => {
  test("fills in the project name and pins the studio's origin", () => {
    expect(pullCommands("contact-form-x7k2mq", ORIGIN)).toEqual([
      "npm i -g @alexkroman1/aai-cli",
      `aai login --server ${ORIGIN}`,
      `aai pull contact-form-x7k2mq --server ${ORIGIN}`,
      "cd contact-form-x7k2mq && aai dev",
    ]);
  });
});

describe("CliCommands", () => {
  test("renders every command", () => {
    render(<CliCommands project="demo" origin={ORIGIN} />);
    for (const command of pullCommands("demo", ORIGIN)) {
      expect(screen.getByText(command)).toBeTruthy();
    }
  });

  test("copies one command and flashes the button", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CliCommands project="demo" origin={ORIGIN} />);

    const pull = `aai pull demo --server ${ORIGIN}`;
    fireEvent.click(screen.getByLabelText(`Copy: ${pull}`));
    expect(writeText).toHaveBeenCalledWith(pull);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  test("copies the whole sequence at once", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CliCommands project="demo" origin={ORIGIN} />);

    fireEvent.click(screen.getByText("Copy all"));
    expect(writeText).toHaveBeenCalledWith(pullCommands("demo", ORIGIN).join("\n"));
    expect(await screen.findByText("Copied all")).toBeTruthy();
  });

  test("a clipboard-less context reports the failure instead of claiming success", async () => {
    vi.stubGlobal("navigator", {});
    render(<CliCommands project="demo" origin={ORIGIN} />);

    fireEvent.click(screen.getByLabelText("Copy: npm i -g @alexkroman1/aai-cli"));
    expect(await screen.findByText("Failed")).toBeTruthy();
  });

  test("a denied clipboard write reports the failure too", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CliCommands project="demo" origin={ORIGIN} />);

    fireEvent.click(screen.getByLabelText("Copy: npm i -g @alexkroman1/aai-cli"));
    expect(await screen.findByText("Failed")).toBeTruthy();
  });
});
