// Copyright 2026 the AAI authors. MIT license.
/**
 * Escape / click-away dismissal for the top bar's dropdown panels (Publish,
 * Account). Both are opened by a TOGGLE button, and that button must exempt
 * itself from the click-away handler: without the exemption, pressing a
 * pressed toggle is seen as "clicked away" first, closes the panel, and the
 * toggle's own click then reopens it — so the second press looks like it did
 * nothing. The toggle marks itself with `toggleAttr`; the panel is found by
 * ref.
 */

import type { RefObject } from "react";
import { useEffect } from "react";

export function useDismissablePanel(opts: {
  open: boolean;
  onClose: () => void;
  panel: RefObject<HTMLElement | null>;
  /** Bare attribute name the panel's toggle button carries. */
  toggleAttr: string;
}): void {
  const { open, onClose, panel, toggleAttr } = opts;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (panel.current?.contains(target as Node)) return;
      if (target?.closest?.(`[${toggleAttr}]`)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, onClose, panel, toggleAttr]);
}
