import { describe, expect, it } from "vitest";
import { date, dateTime, plural, windowCounts, word } from "./format";

// Plan #1 on Onyx: 0.5 GNOT every 30 days, read at 2026-11-24 21:10 UTC. The realm's
// PeriodStart is now / period * period: 2026-11-03 00:00 UTC, three weeks before the plan existed.
const NOW = 1_795_554_600n;
const DAYS_30 = 2_592_000n;
const START = (NOW / DAYS_30) * DAYS_30;

describe("dates say their zone", () => {
  it("a date alone is the UTC day, labelled UTC", () => {
    expect(date(1_798_146_180n)).toBe("24 Dec 2026 UTC"); // 24 Dec 2026 21:03 UTC: already 25 Dec east of UTC+3
  });
  it("a date and time", () => {
    expect(dateTime(1_798_146_180n)).toBe("24 Dec 2026, 21:03 UTC");
  });
});

describe("counts beside their noun", () => {
  it("singular for exactly 1, plural otherwise", () => {
    expect(word(1, "plan")).toBe("plan");
    expect(word(0, "plan")).toBe("plans");
    expect(word(4, "plan")).toBe("plans");
    expect(word(1n, "Payment")).toBe("Payment");
    expect(word(10n, "Payment")).toBe("Payments");
    expect(word(1, "mandate")).toBe("mandate");
    expect(plural(1, "payment")).toBe("1 payment");
  });
});

describe("payment counts in the realm's counting windows", () => {
  it("say when the current window began, and how long the one before was", () => {
    expect(START).toBe(1_793_664_000n);
    expect(dateTime(START)).toBe("3 Nov 2026, 00:00 UTC");
    expect(windowCounts(1, 0, START, DAYS_30)).toBe("1 payment since 3 Nov 2026, 00:00 UTC · 0 in the 30 days before that");
    // the next window: the one payment is now in the window before, never "0 this period" alone
    expect(windowCounts(0, 1, START + DAYS_30, DAYS_30)).toBe("0 payments since 3 Dec 2026, 00:00 UTC · 1 in the 30 days before that");
  });
  it("short test periods start at a time of day", () => {
    const start = (NOW / 60n) * 60n;
    expect(windowCounts(2, 1, start, 60n)).toBe("2 payments since 24 Nov 2026, 21:10 UTC · 1 in the minute before that");
    expect(windowCounts(1_234, 0, (NOW / 604_800n) * 604_800n, 604_800n)).toMatch(/^1,234 payments since \d{1,2} \w{3} 2026, 00:00 UTC · 0 in the week before that$/);
  });
});
