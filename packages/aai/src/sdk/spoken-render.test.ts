// Copyright 2026 the AAI authors. MIT license.
/**
 * Every output here is pinned to the character, for the reason `format.test.ts`
 * gives: these are what a caller HEARS, so a change to one is a change to what
 * the agent says and should have to be written down.
 */
import { describe, expect, test, vi } from "vitest";

import { formatMoney } from "./format.ts";
import { mintCode, spokenDate, spokenMoney, spokenTime } from "./spoken-render.ts";

/**
 * The spoken form of an amount, derived from its WRITTEN form.
 *
 * Deliberately re-derived rather than re-using `spokenMoney`: the claim is that
 * the two renderings of one number cannot disagree, and a test that asked
 * `spokenMoney` what it thought would assert nothing.
 */
function spokenFromWritten(written: string): string {
  const sign = written.startsWith("-") ? "minus " : "";
  const [dollars = "0", cents = "00"] = written.replace(/[-$,]/g, "").split(".");
  const d = Number(dollars);
  const c = Number(cents);
  const dollarWords = `${d} ${d === 1 ? "dollar" : "dollars"}`;
  const centWords = `${c} ${c === 1 ? "cent" : "cents"}`;
  if (c === 0) return `${sign}${dollarWords}`;
  if (d === 0) return `${sign}${centWords}`;
  return `${sign}${dollarWords} and ${centWords}`;
}

describe("spokenMoney", () => {
  test("reads dollars and cents", () => {
    expect(spokenMoney(240.5)).toBe("240 dollars and 50 cents");
    expect(spokenMoney(240)).toBe("240 dollars");
    expect(spokenMoney(0)).toBe("0 dollars");
  });

  test("uses the singular for exactly one", () => {
    expect(spokenMoney(1)).toBe("1 dollar");
    expect(spokenMoney(1.01)).toBe("1 dollar and 1 cent");
  });

  test("drops the dollar half under a dollar", () => {
    expect(spokenMoney(0.75)).toBe("75 cents");
    expect(spokenMoney(0.01)).toBe("1 cent");
  });

  test("says the word 'minus' rather than emitting a sign", () => {
    // A `-` is read as silence or as "dash" depending on the engine, and a
    // refund read as a charge is the worst outcome available here.
    expect(spokenMoney(-4.99)).toBe("minus 4 dollars and 99 cents");
  });

  test("loses the sign when the amount ROUNDS to zero", () => {
    expect(spokenMoney(-0.001)).toBe("0 dollars");
  });

  test("degrades non-finite the way formatMoney does", () => {
    expect(spokenMoney(Number.NaN)).toBe("0 dollars");
    expect(spokenMoney(Number.POSITIVE_INFINITY)).toBe("0 dollars");
  });

  test("rounds the same way formatMoney does, so the two never disagree", () => {
    // The property that matters: a page and a call describing one number must
    // not differ by a cent. Both derive from one `toFixed(2)`, so the spoken
    // form is reconstructible from the written one — including the two shapes
    // that drop a half (`0 dollars and…` and `…and 0 cents`).
    for (const amount of [0.005, 2292.371, 19.995, 1.005, -7.126, 12.344, 1, 0]) {
      expect(spokenMoney(amount)).toBe(spokenFromWritten(formatMoney(amount)));
    }
  });
});

describe("spokenDate", () => {
  test("names the weekday, the month and the day", () => {
    expect(spokenDate("2026-06-08")).toBe("Monday, June 8");
    expect(spokenDate("2026-01-01")).toBe("Thursday, January 1");
    expect(spokenDate("2024-02-29")).toBe("Thursday, February 29");
  });

  test("reaches for no locale API at all", () => {
    // The property, asserted where it actually lives. `toLocaleDateString`
    // answers to the host's ICU build, so a desk could read dates correctly on
    // a laptop and differently inside a sandbox — and no output-only test
    // catches that, because the test runs on the laptop. Watching the calls
    // does. (`process.env.TZ` would not: Node caches the zone at startup.)
    const locale = vi.spyOn(Date.prototype, "toLocaleDateString");
    const intl = vi.spyOn(Intl, "DateTimeFormat");
    try {
      expect(spokenDate("2026-06-08")).toBe("Monday, June 8");
      expect(spokenTime("18:30")).toBe("6:30 PM");
      expect(locale).not.toHaveBeenCalled();
      expect(intl).not.toHaveBeenCalled();
    } finally {
      locale.mockRestore();
      intl.mockRestore();
    }
  });

  test("returns a value it cannot read unchanged", () => {
    expect(spokenDate("2026-02-30")).toBe("2026-02-30");
    expect(spokenDate("next Tuesday")).toBe("next Tuesday");
  });
});

describe("spokenTime", () => {
  test("drops the minutes on the hour", () => {
    // "7:00 PM" is read as "seven zero zero PM" by some engines.
    expect(spokenTime("19:00")).toBe("7 PM");
  });

  test("keeps them otherwise", () => {
    expect(spokenTime("18:30")).toBe("6:30 PM");
    expect(spokenTime("04:45")).toBe("4:45 AM");
    expect(spokenTime("09:05")).toBe("9:05 AM");
  });

  test("reads midnight and noon as 12", () => {
    expect(spokenTime("00:00")).toBe("12 AM");
    expect(spokenTime("00:30")).toBe("12:30 AM");
    expect(spokenTime("12:00")).toBe("12 PM");
    expect(spokenTime("12:30")).toBe("12:30 PM");
  });

  test("returns a value it cannot read unchanged", () => {
    expect(spokenTime("7 PM")).toBe("7 PM");
    expect(spokenTime("24:00")).toBe("24:00");
  });
});

describe("mintCode", () => {
  /** A source that walks the alphabet, so a spec can name the code it expects. */
  function cycling(values: readonly number[]): () => number {
    let i = 0;
    return () => values[i++ % values.length] as number;
  }

  test("mints PREFIX-XXXX", () => {
    expect(mintCode("HTL", { random: () => 0 })).toBe("HTL-AAAA");
  });

  test("omits every character a caller reads back wrong", () => {
    // 0/O, 1/I and L are the ones that come back wrong down a phone. Drawing
    // the whole alphabet proves none of them can be drawn at all.
    const drawn = new Set<string>();
    for (let i = 0; i < 31; i++) {
      const at = i / 31;
      drawn.add(mintCode("X", { random: () => at, length: 1 }).slice(2));
    }
    for (const forbidden of ["0", "1", "I", "L", "O"]) {
      expect(drawn.has(forbidden)).toBe(false);
    }
    expect(drawn.size).toBe(31);
  });

  test("re-draws past a code already issued", () => {
    // First draw is all-A and taken; the source then yields the next symbol.
    const random = cycling([0, 0, 0, 0, 1 / 31, 1 / 31, 1 / 31, 1 / 31]);
    expect(mintCode("RES", { taken: new Set(["RES-AAAA"]), random })).toBe("RES-BBBB");
  });

  test("honours a length", () => {
    expect(mintCode("DSP", { length: 6, random: () => 0 })).toBe("DSP-AAAAAA");
  });

  test("fails rather than hanging when nothing is free", () => {
    // A full code space must be an error someone can act on, never a call that
    // never returns.
    expect(() => mintCode("X", { length: 1, taken: new Set(["X-A"]), random: () => 0 })).toThrow(
      /no free X-X code/,
    );
  });
});
