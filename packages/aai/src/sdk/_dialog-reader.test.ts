// Copyright 2026 the AAI authors. MIT license.
/**
 * The one-actor read a gated call makes: registered by `dialog()`, and the
 * public-member fallback for a handle nothing registered.
 */
import { expect, test, vi } from "vitest";
import { readDialog, registerDialogReader } from "./_dialog-reader.ts";
import { dialog } from "./dialog.ts";
import type { AnyDialog } from "./dialog-handle.ts";
import { createToolContext } from "./testing.ts";

const flow = () =>
  dialog("flow", {
    initial: "a",
    states: { a: { instruction: "Do A.", on: { NEXT: "b" } }, b: { final: true } },
  });

test("a dialog() handle answers position and matches off ONE read, never through the members", () => {
  const claim = flow();
  const ctx = createToolContext();
  const matches = vi.spyOn(claim, "matches");
  const position = vi.spyOn(claim, "position");
  const at = readDialog(claim, ctx);
  expect(at.position).toMatchObject({ state: "a", done: false, instruction: "Do A." });
  expect(at.matches("a")).toBe(true);
  expect(at.matches("b")).toBe(false);
  expect(matches).not.toHaveBeenCalled();
  expect(position).not.toHaveBeenCalled();
  // A reading is a snapshot: a move after it does not change what it said.
  claim.send(ctx, { type: "NEXT" });
  expect(at.matches("a")).toBe(true);
  expect(readDialog(claim, ctx).position.state).toBe("b");
});

test("a handle nothing registered falls back to its public members", () => {
  const handle = {
    position: vi.fn(() => ({ state: "x", done: false })),
    matches: vi.fn((_ctx: unknown, state: string) => state === "x"),
  } as unknown as AnyDialog;
  const at = readDialog(handle, createToolContext());
  expect(at.position.state).toBe("x");
  expect(at.matches("x")).toBe(true);
  expect(at.matches("y")).toBe(false);
  expect(handle.matches).toHaveBeenCalledTimes(2);
});

test("a registered reader replaces the fallback", () => {
  const handle = { position: vi.fn(), matches: vi.fn() } as unknown as AnyDialog;
  registerDialogReader(handle, () => ({
    position: { state: "r", done: true },
    matches: () => true,
  }));
  expect(readDialog(handle, createToolContext()).position).toEqual({ state: "r", done: true });
  expect(handle.position).not.toHaveBeenCalled();
});
