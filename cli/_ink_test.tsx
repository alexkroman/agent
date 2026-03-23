// Copyright 2025 the AAI authors. MIT license.
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";
import {
  CommandRunner,
  Detail,
  ErrorLine,
  Info,
  interactive,
  primary,
  Step,
  StepInfo,
  StepLog,
  Warn,
} from "./_ink.tsx";

describe("chalk helpers", () => {
  test("primary wraps text", () => {
    const result = primary("hello");
    expect(result).toContain("hello");
    expect(typeof result).toBe("string");
  });

  test("interactive wraps text", () => {
    const result = interactive("world");
    expect(result).toContain("world");
    expect(typeof result).toBe("string");
  });

  test("primary handles empty string", () => {
    expect(typeof primary("")).toBe("string");
  });

  test("interactive handles empty string", () => {
    expect(typeof interactive("")).toBe("string");
  });
});

describe("Ink components render output", () => {
  test("Step renders action and message", () => {
    const { lastFrame } = render(<Step action="Build" msg="completed" />);
    const frame = lastFrame();
    expect(frame).toContain("Build");
    expect(frame).toContain("completed");
  });

  test("StepInfo renders action and message", () => {
    const { lastFrame } = render(<StepInfo action="Fetch" msg="data loaded" />);
    const frame = lastFrame();
    expect(frame).toContain("Fetch");
    expect(frame).toContain("data loaded");
  });

  test("Info renders indented message", () => {
    const { lastFrame } = render(<Info msg="some details" />);
    expect(lastFrame()).toContain("some details");
  });

  test("Detail renders indented message", () => {
    const { lastFrame } = render(<Detail msg="detail text" />);
    expect(lastFrame()).toContain("detail text");
  });

  test("Warn renders warning message", () => {
    const { lastFrame } = render(<Warn msg="watch out" />);
    expect(lastFrame()).toContain("watch out");
  });

  test("ErrorLine renders error message", () => {
    const { lastFrame } = render(<ErrorLine msg="something broke" />);
    expect(lastFrame()).toContain("something broke");
  });

  test("StepLog renders multiple entries", () => {
    const items = [
      { id: 0, node: <Step action="A" msg="first" /> },
      { id: 1, node: <Step action="B" msg="second" /> },
    ];
    const { lastFrame } = render(<StepLog items={items} />);
    const frame = lastFrame();
    expect(frame).toContain("first");
    expect(frame).toContain("second");
  });
});

describe("CommandRunner", () => {
  test("logs steps and exits on completion", async () => {
    const { lastFrame, cleanup } = render(
      <CommandRunner
        run={async ({ log }) => {
          log(<Step action="Step1" msg="done" />);
          log(<Step action="Step2" msg="done" />);
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame();
    expect(frame).toContain("Step1");
    expect(frame).toContain("Step2");
    cleanup();
  });

  test("displays error message on failure", async () => {
    const errors: Error[] = [];
    const { lastFrame, cleanup } = render(
      <CommandRunner
        run={async () => {
          throw new Error("deploy failed");
        }}
        onError={(e) => errors.push(e)}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("deploy failed");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("deploy failed");
    cleanup();
  });

  test("setStatus renders a live status line", async () => {
    let resolveRun: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveRun = r;
    });

    const { lastFrame, cleanup } = render(
      <CommandRunner
        run={async ({ log, setStatus }) => {
          log(<Step action="Build" msg="bundling" />);
          setStatus(<Info msg="75% complete" />);
          await gate;
        }}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame();
    expect(frame).toContain("bundling");
    expect(frame).toContain("75% complete");
    resolveRun?.();
    await new Promise((r) => setTimeout(r, 50));
    cleanup();
  });
});
