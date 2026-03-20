// Copyright 2025 the AAI authors. MIT license.
import type * as preact from "preact";
import { useMountConfig } from "../mount_context.ts";
import { ChatView } from "./chat_view.tsx";
import { StartScreen } from "./start_screen.tsx";

export function App(): preact.JSX.Element {
  const { title } = useMountConfig();

  return (
    <StartScreen title={title ?? "aai"}>
      <ChatView />
    </StartScreen>
  );
}
