// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:hooks` epoch 3.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * **Nothing an author writes changed**, which is why epoch 2 is RETAINED and
 * `./v2.tsx` compiles unchanged beside this file. The epoch moved because the
 * unfiltered overloads of `useToolResult` and `useToolCallStart` gained
 * descriptions of their own — they had been sharing the filtered overload's,
 * which said "optionally filter by tool name" on the signature that takes no
 * tool name — and a doc comment where there was none is visible in the
 * rolled-up report.
 *
 * The reason to freeze it anyway is that both overloads are the contract: a
 * caller picks between them by ARITY, and this file is what proves both still
 * resolve.
 */

import { type ToolCallInfo, useToolCallStart, useToolResult } from "../../../index.ts";

type Quote = { symbol: string; price: number };

/** The filtered overload: one tool, and the callback takes the result first. */
export function OneTool() {
  useToolResult<Quote>("get_quote", (result: Quote, call: ToolCallInfo) => {
    void `${call.name}: ${result.price}`;
  });
  useToolCallStart("get_quote", (call: ToolCallInfo) => {
    void call.callId;
  });
  return null;
}

/** The unfiltered overload: every tool, and the name arrives as an argument. */
export function EveryTool() {
  useToolResult<Quote>((name: string, result: Quote, call: ToolCallInfo) => {
    void `${name} ${result.symbol} ${call.status}`;
  });
  useToolCallStart((call: ToolCallInfo) => {
    void call.name;
  });
  return null;
}
