// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { useTheme } from "../context.ts";
import type { ClientTheme } from "../types.ts";
import { FOCUS_RING, focusRingStyle, INK_SURFACE_PCT, inkTint, primaryTint } from "./_colors.ts";

/**
 * A style object that may also carry CSS custom properties.
 *
 * `CSSProperties` has no index signature, so a `--foo` key is a type error
 * without one. The template-literal key keeps this fully checked — only
 * custom properties are admitted, not arbitrary strings.
 */
type StyleWithVars = CSSProperties & Record<`--${string}`, string>;

/**
 * Rest and hover colors for one variant. Hover is a real requirement rather
 * than polish: `transition-colors` was on this button from the start with
 * nothing to transition, so rest and hover computed *byte-identically* in all
 * three variants — a primary CTA with no feedback to a pointer at all.
 *
 * They travel as custom properties because the base colors have to move off
 * the inline `style` for a `:hover` rule to be able to win at all — an inline
 * declaration beats any class, hover or not. Variables are the one thing a
 * class *can* read back, and consumers keep their override: a `style` prop
 * setting `background` outright is still inline, and still wins.
 */
type VariantColors = {
  bg: string;
  fg: string;
  border: string;
  hoverBg: string;
  hoverFg: string;
  hoverBorder: string;
};

/**
 * Visual style of a {@link Button} (design-system "website refresh":
 * rectangular, ALL-CAPS, tracked labels).
 *
 * - `"default"` — Primary filled button (indigo background).
 * - `"secondary"` — Outlined primary (transparent background, primary border).
 * - `"ghost"` — Raised neutral (surface background with hairline border).
 *
 * @public
 */
export type ButtonVariant = "default" | "secondary" | "ghost";

/**
 * Size preset for a {@link Button}.
 *
 * - `"default"` — Compact control (height 36 px).
 * - `"lg"` — Primary CTA (height 44 px, generous padding).
 *
 * @public
 */
export type ButtonSize = "default" | "lg";

/** One variant's rest and hover colors, derived from the theme. */
function variantColors(variant: ButtonVariant, theme: Required<ClientTheme>): VariantColors {
  switch (variant) {
    case "default":
      return {
        bg: theme.primary,
        fg: theme.surface,
        border: "transparent",
        // Blended toward the theme's own ink, so one rule reads correctly on a
        // dark theme (where "toward ink" is lighter) as on a light one.
        hoverBg: inkTint(theme.text, theme.primary, 14),
        hoverFg: theme.surface,
        hoverBorder: "transparent",
      };
    case "secondary":
      return {
        bg: "transparent",
        fg: theme.primary,
        border: theme.primary,
        hoverBg: primaryTint(theme.primary, theme.surface, 8),
        hoverFg: theme.primary,
        hoverBorder: theme.primary,
      };
    default:
      return {
        bg: theme.surface,
        fg: theme.text,
        border: theme.border,
        hoverBg: inkTint(theme.text, theme.surface, INK_SURFACE_PCT + 2),
        hoverFg: theme.text,
        hoverBorder: theme.border,
      };
  }
}

/**
 * A styled button with variant and size presets.
 *
 * Accepts all standard `<button>` HTML attributes in addition to the props
 * listed below.
 *
 * @example
 * ```tsx
 * import { Button } from "@alexkroman1/aai-ui";
 *
 * function Actions({ onStop }: { onStop: () => void }) {
 *   return (
 *     <>
 *       <Button variant="secondary" onClick={onStop}>Stop</Button>
 *       <Button size="lg" className="w-full">Start Conversation</Button>
 *     </>
 *   );
 * }
 * ```
 *
 * @param props - Button props: `variant` (visual style — see
 * {@link ButtonVariant}, defaults to `"default"`), `size` (see
 * {@link ButtonSize}, defaults to `"default"`), `className` (appended to the
 * button's own classes), `children` (the label), and any `<button>` attribute.
 *
 * @public
 */
export function Button({
  variant = "default",
  size = "default",
  className,
  children,
  style,
  ...rest
}: {
  /** Visual style. Defaults to `"default"`. */
  variant?: ButtonVariant;
  /** Size preset. Defaults to `"default"`. */
  size?: ButtonSize;
  /** Additional CSS class names, appended to the button's own. */
  className?: string;
  /** Button label / content. */
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  const theme = useTheme();
  const colors = variantColors(variant, theme);

  const vars: StyleWithVars = {
    "--aai-btn-bg": colors.bg,
    "--aai-btn-fg": colors.fg,
    "--aai-btn-bd": colors.border,
    "--aai-btn-bg-hover": colors.hoverBg,
    "--aai-btn-fg-hover": colors.hoverFg,
    "--aai-btn-bd-hover": colors.hoverBorder,
    ...focusRingStyle(theme.primary),
    ...style,
  };

  return (
    <button
      type="button"
      style={vars}
      className={clsx(
        "inline-flex items-center justify-center appearance-none m-0 w-fit whitespace-nowrap",
        size === "lg" ? "h-11 px-7 text-xs" : "h-9 px-5 text-[11px]",
        "rounded-aai font-aai font-medium tracking-[1.4px] uppercase leading-none",
        "cursor-pointer border transition-colors duration-150",
        "bg-(--aai-btn-bg) text-(--aai-btn-fg) border-(--aai-btn-bd)",
        "enabled:hover:bg-(--aai-btn-bg-hover) enabled:hover:text-(--aai-btn-fg-hover)",
        "enabled:hover:border-(--aai-btn-bd-hover)",
        FOCUS_RING,
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
