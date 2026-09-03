// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { useSessionCore, useSessionSelector, useTheme } from "../context.ts";
import { INK_MUTED_PCT, inkTint } from "./_colors.ts";
import { AaiLogo } from "./aai-logo.tsx";
import { Button } from "./button.tsx";
import { Eyebrow } from "./eyebrow.tsx";

/**
 * A centered start screen: a white card on the cream page with the logo, an
 * eyebrow label, a serif title, subtitle, and the start CTA. Renders
 * `children` (the main app) once the session has started.
 *
 * @example
 * ```tsx
 * import { ChatView, StartScreen } from "@alexkroman1/aai-ui";
 *
 * function MyAgent() {
 *   return (
 *     <StartScreen icon="🍕" title="Pizza Palace" subtitle="Voice-powered ordering">
 *       <ChatView />
 *     </StartScreen>
 *   );
 * }
 * ```
 *
 * @param props - Start-screen props.
 *
 * @public
 */
export function StartScreen({
  children,
  icon,
  title,
  subtitle,
  buttonText = "Start Conversation",
  className,
}: {
  /** The app, rendered once the session has started. */
  children: ReactNode;
  /** Element rendered in place of the logo on the card. */
  icon?: ReactNode | undefined;
  /** The card's serif title. Defaults to the agent's declared name. */
  title?: string | undefined;
  /** A line under the title. */
  subtitle?: string | undefined;
  /** Label of the start CTA. Defaults to `"Start Conversation"`. */
  buttonText?: string | undefined;
  /** Additional CSS class names for the root element, appended to its own. */
  className?: string | undefined;
}): ReactNode {
  // Narrow subscription: only re-render when `started` flips, not on every
  // snapshot change.
  const started = useSessionSelector((s) => s.started);
  const { start } = useSessionCore();
  const theme = useTheme();

  if (started) {
    return children;
  }

  return (
    <div
      className={clsx("flex items-center justify-center h-screen font-aai", className)}
      style={{ background: theme.bg }}
    >
      <div
        className="flex flex-col items-center gap-5 border rounded-xl px-10 py-12 sm:px-16 sm:py-14 max-w-105 text-center"
        style={{
          background: theme.surface,
          borderColor: theme.border,
          boxShadow: "0 4px 12px -2px rgb(20 18 12 / 0.08)",
        }}
      >
        {icon ?? <AaiLogo size={24} />}
        <Eyebrow>Voice Agent</Eyebrow>
        {title && (
          <h1
            className="font-aai-serif font-normal text-[32px] leading-[1.15] tracking-[-0.2px] m-0 text-balance"
            style={{ color: theme.text }}
          >
            {title}
          </h1>
        )}
        {subtitle && (
          <p
            className="text-[15px] leading-[22px] m-0 max-w-75"
            style={{ color: inkTint(theme.text, theme.surface, INK_MUTED_PCT) }}
          >
            {subtitle}
          </p>
        )}
        <Button size="lg" className="mt-2" onClick={start}>
          {buttonText}
        </Button>
      </div>
    </div>
  );
}
