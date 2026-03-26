// Copyright 2025 the AAI authors. MIT license.
import type * as preact from "preact";
import { useMountConfig } from "../mount-context.ts";
import { ChatView } from "./chat-view.tsx";
import { StartScreen } from "./start-screen.tsx";

function AnsiLogo() {
  return (
    <pre class="font-aai-mono text-lg leading-[1.1] font-bold text-aai-primary m-0">
      {/* biome-ignore lint/style/useConsistentCurlyBraces: string contains escape sequence */}
      {"▄▀█ ▄▀█ █\n█▀█ █▀█ █"}
    </pre>
  );
}

/**
 * The default top-level UI component for an AAI voice agent.
 * Renders a {@link StartScreen} (with the AAI logo or a custom title from
 * {@link useMountConfig}) followed by a {@link ChatView} once the session starts.
 *
 * This is the component rendered by {@link mount} when no custom component is
 * provided.
 *
 * @example
 * ```tsx
 * import { App, mount } from "@aai/ui";
 *
 * mount(App, { target: "#app", title: "My Agent" });
 * ```
 *
 * @param className - Additional CSS class names applied to the root element.
 *
 * @public
 */
export function App({ className }: { className?: string }): preact.JSX.Element {
  const { title } = useMountConfig();

  return (
    <StartScreen icon={title ? undefined : <AnsiLogo />} title={title} className={className}>
      <ChatView />
    </StartScreen>
  );
}
