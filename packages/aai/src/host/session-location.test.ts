// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import {
  getSessionLocation,
  sessionCoords,
  setSessionLocation,
  townOf,
} from "./session-location.ts";

const here = { latitude: 45.56, longitude: -122.55 };

describe("session location", () => {
  test("is per session, and absent for a session that reported none", () => {
    setSessionLocation("loc-a", "123 Example St, Portland, OR 97201");
    expect(getSessionLocation({ sessionId: "loc-a" })).toBe("123 Example St, Portland, OR 97201");
    expect(getSessionLocation({ sessionId: "loc-never" })).toBeUndefined();
  });

  test("coordinates resolve once per location, and a failed lookup is not retried", async () => {
    setSessionLocation("loc-b", "somewhere");
    const resolve = vi.fn(() => Promise.resolve(here));
    expect(await sessionCoords({ sessionId: "loc-b" }, resolve)).toEqual(here);
    expect(await sessionCoords({ sessionId: "loc-b" }, resolve)).toEqual(here);
    expect(resolve).toHaveBeenCalledTimes(1);

    setSessionLocation("loc-c", "nowhere");
    const miss = vi.fn(() => Promise.resolve(undefined));
    expect(await sessionCoords({ sessionId: "loc-c" }, miss)).toBeUndefined();
    expect(await sessionCoords({ sessionId: "loc-c" }, miss)).toBeUndefined();
    expect(miss).toHaveBeenCalledTimes(1);
  });

  test("a resume with the same location keeps the coordinates; a new one drops them", async () => {
    setSessionLocation("loc-d", "first");
    const resolve = vi.fn(() => Promise.resolve(here));
    await sessionCoords({ sessionId: "loc-d" }, resolve);
    setSessionLocation("loc-d", "first");
    await sessionCoords({ sessionId: "loc-d" }, resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    setSessionLocation("loc-d", "second");
    await sessionCoords({ sessionId: "loc-d" }, resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test("no location means no lookup", async () => {
    const resolve = vi.fn(() => Promise.resolve(here));
    expect(await sessionCoords({ sessionId: "loc-none" }, resolve)).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  test("townOf keeps the town and region of a street address", () => {
    expect(townOf("123 Example St, Portland, OR 97201")).toBe("Portland, OR");
    // A five-digit house number is not a postcode to strip before the street goes.
    expect(townOf("12345 Example Ave, Springfield, IL 62701")).toBe("Springfield, IL");
    expect(townOf("1 Main St, Springfield, IL 62701-1234, US")).toBe("Springfield, IL, US");
    // Google's formatting leads with the PLACE, house number after: every leading part
    // with a digit in it is street, and the first plain name is the town.
    expect(townOf("Infinite Loop 1, 1 Infinite Loop, Cupertino, CA 95014, USA")).toBe(
      "Cupertino, CA, USA",
    );
    expect(townOf("Portland, OR 97201")).toBe("Portland, OR");
    expect(townOf("Paris, France")).toBe("Paris, France");
    expect(townOf("Denver")).toBe("Denver");
  });
});
