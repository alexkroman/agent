// Copyright 2026 the AAI authors. MIT license.
// The chat-availability footnote: it speaks only while `/studio/status` is
// outstanding, and once the status lands there is nothing to report.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { StudioStatus } from "../api.ts";
import { ChatStatusNote } from "./chat-status-note.tsx";

describe("ChatStatusNote", () => {
  test("says what it is waiting for while the status is unknown", () => {
    expect(renderToStaticMarkup(<ChatStatusNote status={undefined} />)).toContain(
      "Checking the server&#x27;s chat status…",
    );
  });

  test("renders nothing once the status has landed", () => {
    const status = {} as StudioStatus;
    expect(renderToStaticMarkup(<ChatStatusNote status={status} />)).toBe("");
  });
});
