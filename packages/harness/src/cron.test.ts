import { describe, expect, it } from "vitest";
import { cronMatches, nextCronOccurrence, parseCron } from "./cron.js";

describe("cron", () => {
  it("parses and matches standard expressions", () => {
    const c = parseCron("*/15 * * * *");
    expect(cronMatches(c, new Date(2026, 8, 19, 10, 0))).toBe(true);
    expect(cronMatches(c, new Date(2026, 8, 19, 10, 15))).toBe(true);
    expect(cronMatches(c, new Date(2026, 8, 19, 10, 7))).toBe(false);

    const daily = parseCron("30 9 * * 1-5");
    expect(cronMatches(daily, new Date(2026, 8, 21, 9, 30))).toBe(true); // Monday
    expect(cronMatches(daily, new Date(2026, 8, 20, 9, 30))).toBe(false); // Sunday

    const lists = parseCron("0 0 1,15 * *");
    expect(cronMatches(lists, new Date(2026, 8, 1, 0, 0))).toBe(true);
    expect(cronMatches(lists, new Date(2026, 8, 2, 0, 0))).toBe(false);
  });

  it("rejects invalid expressions", () => {
    expect(() => parseCron("*/15 * * *")).toThrow();
    expect(() => parseCron("99 * * * *")).toThrow();
    expect(() => parseCron("* * * * * *")).toThrow();
    expect(() => parseCron("a b c d e")).toThrow();
  });

  it("computes the next occurrence", () => {
    const from = new Date(2026, 8, 19, 10, 7); // Saturday 10:07
    const next = nextCronOccurrence("*/15 * * * *", from);
    expect(next).toEqual(new Date(2026, 8, 19, 10, 15));

    const nextDaily = nextCronOccurrence("30 9 * * 1-5", new Date(2026, 8, 19, 12, 0)); // Sat after slot
    expect(nextDaily?.getDay()).toBe(1); // Monday
    expect(nextDaily).toEqual(new Date(2026, 8, 21, 9, 30));

    // Next occurrence is strictly after `from` even when from matches exactly.
    const exact = new Date(2026, 8, 19, 10, 15);
    expect(nextCronOccurrence("*/15 * * * *", exact)).toEqual(new Date(2026, 8, 19, 10, 30));
  });

  it("treats 7 as Sunday in day-of-week", () => {
    const sunday = nextCronOccurrence("0 12 * * 7", new Date(2026, 8, 19, 12, 1)); // Sat 12:01
    expect(sunday?.getDay()).toBe(0);
    expect(sunday).toEqual(new Date(2026, 8, 20, 12, 0));
  });
});
