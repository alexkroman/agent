// Copyright 2025 the AAI authors. MIT license.
import type * as preact from "preact";
import { useMountConfig } from "../mount_context.ts";
import { ChatView } from "./chat_view.tsx";
import { StartScreen } from "./start_screen.tsx";

function AnsiLogo() {
  return (
    <pre class="font-aai-mono text-lg leading-[1.1] font-bold text-aai-primary m-0">
      {"▄▀█ ▄▀█ █\n█▀█ █▀█ █"}
    </pre>
  );
}

export function App(): preact.JSX.Element {
  const { title } = useMountConfig();

  return (
    <StartScreen icon={title ? undefined : <AnsiLogo />} title={title}>
      <ChatView />
    </StartScreen>
  );
}
