// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for the public API of `@alexkroman1/aai-ui`.
 *
 * These are checked by tsc (via vitest typecheck) but never executed at runtime.
 */

import type {
  AgentState,
  ChatMessage,
  Session,
  SessionCore,
  SessionError,
  SessionSnapshot,
} from "@alexkroman1/aai-ui";
import { expectTypeOf, test } from "vitest";

test("SessionCore has expected control method properties", () => {
  expectTypeOf<SessionCore["subscribe"]>().toBeFunction();
  expectTypeOf<SessionCore["getSnapshot"]>().toBeFunction();
  expectTypeOf<SessionCore["connect"]>().toBeFunction();
  expectTypeOf<SessionCore["disconnect"]>().toBeFunction();
  expectTypeOf<SessionCore["cancel"]>().toBeFunction();
  expectTypeOf<SessionCore["start"]>().toBeFunction();
  expectTypeOf<SessionCore["toggle"]>().toBeFunction();
});

test("SessionCore.getSnapshot returns SessionSnapshot", () => {
  expectTypeOf<SessionCore["getSnapshot"]>().returns.toEqualTypeOf<SessionSnapshot>();
});

test("SessionSnapshot has state/messages/toolCalls/error/started/running fields", () => {
  expectTypeOf<SessionSnapshot["state"]>().toEqualTypeOf<AgentState>();
  expectTypeOf<SessionSnapshot["messages"]>().toEqualTypeOf<ChatMessage[]>();
  expectTypeOf<SessionSnapshot["error"]>().toEqualTypeOf<SessionError | null>();
  expectTypeOf<SessionSnapshot["started"]>().toEqualTypeOf<boolean>();
  expectTypeOf<SessionSnapshot["running"]>().toEqualTypeOf<boolean>();
});

test("SessionSnapshot.state is AgentState (string union)", () => {
  type State = SessionSnapshot["state"];
  expectTypeOf<State>().toEqualTypeOf<AgentState>();
  // AgentState is a string union — verify it extends string
  expectTypeOf<State>().toMatchTypeOf<string>();
});

test("SessionSnapshot.messages is ChatMessage[]", () => {
  type Messages = SessionSnapshot["messages"];
  expectTypeOf<Messages>().toEqualTypeOf<ChatMessage[]>();
  // ChatMessage has role and content
  type Msg = ChatMessage;
  expectTypeOf<Msg["role"]>().toEqualTypeOf<"user" | "assistant">();
  expectTypeOf<Msg["content"]>().toEqualTypeOf<string>();
});

test("SessionSnapshot.error is SessionError | null", () => {
  type Err = SessionSnapshot["error"];
  expectTypeOf<Err>().toEqualTypeOf<SessionError | null>();
});

test("Session extends SessionSnapshot with control methods", () => {
  // Session should be assignable to SessionSnapshot (it extends it)
  expectTypeOf<Session>().toMatchTypeOf<SessionSnapshot>();
  // Session has control methods
  expectTypeOf<Session["start"]>().toBeFunction();
  expectTypeOf<Session["cancel"]>().toBeFunction();
  expectTypeOf<Session["disconnect"]>().toBeFunction();
  expectTypeOf<Session["toggle"]>().toBeFunction();
});
