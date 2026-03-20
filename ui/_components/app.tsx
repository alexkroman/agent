// Copyright 2025 the AAI authors. MIT license.
import type * as preact from "preact";
import { useMountConfig } from "../mount_context.ts";
import { ChatView } from "./chat_view.tsx";
import { StartScreen } from "./start_screen.tsx";

function AaiLogo() {
  return (
    <span class="font-aai-mono text-lg leading-[1.1] font-bold text-aai-primary block text-center">
      {"▄▀█ ▄▀█ █"}
      <br />
      {"█▀█ █▀█ █"}
    </span>
  );
}

export function App(): preact.JSX.Element {
  const { title } = useMountConfig();

  return (
    <StartScreen icon={title ? undefined : <AaiLogo />} title={title}>
      <ChatView />
    </StartScreen>
  );
}
