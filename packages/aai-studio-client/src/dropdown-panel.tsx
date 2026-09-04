// Copyright 2026 the AAI authors. MIT license.
// The chrome both of the top bar's dropdowns hang in (Publish, Account).
//
// `dismissable.ts` already shared the HOOK half; what stayed copied was the
// four-part protocol around it — a panel ref, the hook call, `if (!open) return
// null`, and a byte-identical `absolute top-14 right-5 z-10 …` box with its
// `role="dialog"` and label. Two copies, so a width or z-index change reached
// one of the two panels and the other silently disagreed.

import type { ReactNode } from "react";
import { useRef } from "react";
import { useDismissablePanel } from "./dismissable.ts";

export type DropdownPanelProps = {
  /** The `aria-controls` target its toggle button names. */
  id: string;
  /** The dialog's accessible name — the toggle's own word for it. */
  label: string;
  open: boolean;
  onClose: () => void;
  /** Bare attribute the toggle carries so it exempts itself from click-away. */
  toggleAttr: string;
  children: ReactNode;
};

export function DropdownPanel({
  id,
  label,
  open,
  onClose,
  toggleAttr,
  children,
}: DropdownPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  useDismissablePanel({ open, onClose, panel, toggleAttr });
  if (!open) return null;
  return (
    <div
      ref={panel}
      id={id}
      role="dialog"
      aria-label={label}
      className="absolute top-14 right-5 z-10 flex w-96 flex-col gap-3 rounded-lg border border-line bg-panel p-5 shadow-md"
    >
      {children}
    </div>
  );
}
