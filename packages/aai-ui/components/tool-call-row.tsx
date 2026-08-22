// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import { type ReactNode, useState } from "react";
import { useTheme } from "../context.ts";
import { INK_FAINT_PCT, inkTint } from "./_colors.ts";
import { Eyebrow } from "./eyebrow.tsx";

/**
 * Size preset for {@link ToolCallRow}: `"default"` is the deployed agent
 * UI's scale, `"compact"` the studio transcript's denser one.
 *
 * @public
 */
export type ToolCallRowVariant = "default" | "compact";

const VARIANT_CLASSES: Record<
  ToolCallRowVariant,
  { button: string; title: string; chevron: string }
> = {
  default: {
    button: "gap-2.5 px-3.5 py-2.5",
    title: "text-[13px]",
    chevron: "text-[10px]",
  },
  compact: {
    button: "gap-2 px-3 py-2",
    title: "text-[11px]",
    chevron: "text-[9px]",
  },
};

/**
 * Props for {@link ToolCallRow}.
 *
 * @public
 */
export interface ToolCallRowProps {
  /** Tool title, rendered in mono (shimmers while `pending`). */
  title: ReactNode;
  /** One-line detail (typically an args preview), truncated to the row. */
  detail?: ReactNode | undefined;
  /** True while the call is in flight — animates the title with a shimmer. */
  pending?: boolean | undefined;
  /** Optional icon rendered in place of the outlined "TOOL" chip. */
  icon?: ReactNode | undefined;
  /** Size preset; defaults to `"default"`. */
  variant?: ToolCallRowVariant | undefined;
  /** Additional CSS class names for the outer container. */
  className?: string | undefined;
  /**
   * Expanded panel content. When present the row is expandable: a chevron is
   * shown and clicking toggles the panel. When absent the row is inert (the
   * button is disabled). Content provides its own padding and typography;
   * the panel supplies the top border, surface background, and a max height.
   */
  children?: ReactNode;
}

/**
 * The design system's console row for one tool invocation: a small outlined
 * "TOOL" chip (or a custom `icon`), the tool title in mono, a truncated
 * detail preview, and a rotating chevron that expands to the panel content.
 *
 * Purely presentational — callers own the mapping from their tool-call data
 * to `title`/`detail`/`pending` and the expanded panel. The deployed agent
 * UI's message list renders it via its tool-call block, and the studio's
 * chat transcript renders it with `variant="compact"`, so the two surfaces
 * read as one component.
 *
 * Colors come from the nearest theme context (see {@link useTheme}); without
 * a provider the default AssemblyAI theme applies.
 *
 * @example
 * ```tsx
 * import { ToolCallRow, useSession } from "@alexkroman1/aai-ui";
 *
 * // A custom chrome's tool log, from the snapshot's own `toolCalls`.
 * function ToolLog() {
 *   const { toolCalls } = useSession();
 *   return (
 *     <div>
 *       {toolCalls.map((call) => (
 *         <ToolCallRow
 *           key={call.callId}
 *           title={call.name}
 *           detail={call.result}
 *           pending={call.status === "pending"}
 *         />
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 *
 * @param props - See {@link ToolCallRowProps}.
 *
 * @public
 */
export function ToolCallRow({
  title,
  detail,
  pending = false,
  icon,
  variant = "default",
  className,
  children,
}: ToolCallRowProps): ReactNode {
  const [isOpen, setIsOpen] = useState(false);
  const theme = useTheme();
  const sizes = VARIANT_CLASSES[variant];
  const canExpand = children != null;
  // The chip, the detail preview and the chevron are all one step: derived once
  // rather than three times per render.
  const faint = inkTint(theme.text, theme.bg, INK_FAINT_PCT);

  return (
    <div
      className={clsx("flex flex-col rounded-md border overflow-hidden", className)}
      style={{ borderColor: theme.border, background: theme.bg }}
    >
      <button
        type="button"
        aria-expanded={canExpand ? isOpen : undefined}
        disabled={!canExpand}
        className={clsx(
          "flex items-center select-none text-left w-full appearance-none border-none bg-transparent",
          sizes.button,
          canExpand && "cursor-pointer",
        )}
        onClick={() => {
          if (canExpand) setIsOpen(!isOpen);
        }}
      >
        {icon ? (
          <span className="w-4 h-4 shrink-0 text-center leading-4">{icon}</span>
        ) : (
          <Eyebrow className="shrink-0" style={{ color: faint }}>
            Tool
          </Eyebrow>
        )}
        {/*
         * `truncate`, not `shrink-0`. Unshrinkable, a long tool name pushed
         * the detail to zero width and then shoved the chevron out of this
         * container's `overflow-hidden` — measured on the 760px column, the
         * args preview vanished at a 74-character name and the chevron was
         * clipped at 76 (44 and 46 in a 520px window). The row still
         * expanded on click, but the only affordance saying so had been
         * cropped away, so an expandable row read as an inert one.
         */}
        <span
          className={clsx(
            "min-w-0 truncate font-aai-mono font-medium",
            sizes.title,
            pending && "tool-shimmer",
          )}
          style={{ color: theme.text }}
        >
          {title}
        </span>
        <span
          className={clsx("font-aai-mono truncate flex-1 min-w-0", sizes.title)}
          style={{ color: faint }}
        >
          {detail}
        </span>
        {canExpand && (
          <span
            className={clsx(
              "shrink-0 transition-transform duration-150",
              sizes.chevron,
              isOpen && "rotate-90",
            )}
            style={{ color: faint }}
          >
            ▶
          </span>
        )}
      </button>
      {isOpen && canExpand && (
        <div
          className="border-t max-h-64 overflow-auto"
          style={{ borderColor: theme.border, background: theme.surface }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
