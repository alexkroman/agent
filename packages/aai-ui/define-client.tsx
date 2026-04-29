// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import type { ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ChatView } from "./components/chat-view.tsx";
import { SidebarLayout } from "./components/sidebar-layout.tsx";
import { StartScreen } from "./components/start-screen.tsx";
import { ToolConfigContext, type ToolDisplayConfig } from "./components/tool-config-context.ts";
import { SessionProvider, ThemeProvider } from "./context.ts";
import { createSessionCore, type SessionCore, type WebSocketConstructor } from "./session-core.ts";
import type { ClientTheme } from "./types.ts";

type BaseOptions = {
  target?: string | HTMLElement;
  platformUrl?: string;
  theme?: ClientTheme;
  onSessionId?: (sessionId: string) => void;
  resumeSessionId?: string;
  WebSocket?: WebSocketConstructor;
};

type ConfigTier = BaseOptions & {
  component?: never;
  name?: string;
  sidebar?: ComponentType;
  sidebarWidth?: string;
  tools?: ToolDisplayConfig;
};

type ComponentTier = BaseOptions & {
  component: ComponentType;
  name?: never;
  sidebar?: never;
  sidebarWidth?: never;
  tools?: never;
};

export type ClientConfig = ConfigTier | ComponentTier;

export type ClientHandle = {
  session: SessionCore;
  dispose(): void;
  [Symbol.dispose](): void;
};

function resolveContainer(target: string | HTMLElement = "#app"): HTMLElement {
  if (typeof target !== "string") return target;
  const el = document.querySelector<HTMLElement>(target);
  if (!el) throw new Error(`Element not found: ${target}`);
  return el;
}

function DefaultShell({
  name,
  Sidebar,
  sidebarWidth,
}: {
  name?: string;
  Sidebar?: ComponentType;
  sidebarWidth?: string;
}) {
  const chat = <ChatView {...(name !== undefined ? { title: name } : {})} />;

  const inner = Sidebar ? (
    <SidebarLayout sidebar={<Sidebar />} {...(sidebarWidth !== undefined ? { sidebarWidth } : {})}>
      {chat}
    </SidebarLayout>
  ) : (
    chat
  );

  return <StartScreen {...(name !== undefined ? { title: name } : {})}>{inner}</StartScreen>;
}

export function client(config: ClientConfig): ClientHandle {
  const container = resolveContainer(config.target);
  const platformUrl =
    config.platformUrl ?? globalThis.location.origin + globalThis.location.pathname;

  const session = createSessionCore({
    platformUrl,
    onSessionId: config.onSessionId,
    resumeSessionId: config.resumeSessionId,
    ...(config.WebSocket ? { WebSocket: config.WebSocket } : {}),
  });

  const RootComponent: ComponentType = config.component
    ? config.component
    : () => (
        <DefaultShell
          {...(config.name !== undefined ? { name: config.name } : {})}
          {...(config.sidebar !== undefined ? { Sidebar: config.sidebar } : {})}
          {...(config.sidebarWidth !== undefined ? { sidebarWidth: config.sidebarWidth } : {})}
        />
      );

  const toolConfig: ToolDisplayConfig = ("tools" in config && config.tools) || {};

  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <ToolConfigContext.Provider value={toolConfig}>
        <ThemeProvider {...(config.theme !== undefined ? { value: config.theme } : {})}>
          <SessionProvider value={session}>
            <RootComponent />
          </SessionProvider>
        </ThemeProvider>
      </ToolConfigContext.Provider>,
    );
  });

  const handle: ClientHandle = {
    session,
    dispose() {
      root.unmount();
      session[Symbol.dispose]();
    },
    [Symbol.dispose]() {
      handle.dispose();
    },
  };
  return handle;
}
