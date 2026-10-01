import { useEffect, useState } from "react";
import type { Led } from "./use-speaker.ts";

// The speaker's light ring: seven LEDs, one color per state, and a comet chasing around
// the ring while it thinks.

const LEDS = 7;
const SPIN_PERIOD_MS = 70;
const TAIL = [1, 0.35, 0.1]; // head, then the fading tail

const COLOR: Record<Led, string> = {
  off: "#27272a",
  connecting: "#d4d4d8",
  listening: "#3b5bff",
  thinking: "#b300ff",
  speaking: "#00e5e5",
  error: "#ff2020",
};
const SPINS: ReadonlySet<Led> = new Set(["thinking"]);

export function Ring({ led, size = 224 }: { led: Led; size?: number }) {
  const [head, setHead] = useState(0);
  const spins = SPINS.has(led);
  useEffect(() => {
    if (!spins) return;
    const id = setInterval(() => setHead((h) => (h + 1) % LEDS), SPIN_PERIOD_MS);
    return () => clearInterval(id);
  }, [spins]);

  const r = size / 2 - 14;
  return (
    <div className="relative" style={{ width: size, height: size }} aria-hidden="true">
      {Array.from({ length: LEDS }, (_, i) => {
        const angle = (i / LEDS) * 2 * Math.PI - Math.PI / 2;
        const behind = (head - i + LEDS) % LEDS;
        const level = led === "off" ? 1 : spins ? (TAIL[behind] ?? 0) : 1;
        const lit = led !== "off" && level > 0;
        return (
          <span
            // Index keys: the ring's LEDs are positional
            key={i}
            className="absolute size-5 rounded-full transition-colors duration-150"
            style={{
              left: size / 2 + r * Math.cos(angle) - 10,
              top: size / 2 + r * Math.sin(angle) - 10,
              background: lit ? COLOR[led] : COLOR.off,
              opacity: lit ? 0.25 + 0.75 * level : 1,
              boxShadow: lit ? `0 0 ${12 * level}px ${COLOR[led]}` : "none",
            }}
          />
        );
      })}
    </div>
  );
}
