import { describe, expect, it } from "vitest";
import { coherentOfflineTimeoutSeconds } from "../src/model";

describe("polling settings", () => {
  it("keeps the offline timeout at least as long as the refresh interval", () => {
    expect(coherentOfflineTimeoutSeconds(5, 60)).toBe(60);
    expect(coherentOfflineTimeoutSeconds(30, 5)).toBe(30);
    expect(coherentOfflineTimeoutSeconds(10, 10)).toBe(10);
  });

  it("normalizes invalid values", () => {
    expect(coherentOfflineTimeoutSeconds(Number.NaN, 30)).toBe(30);
    expect(coherentOfflineTimeoutSeconds(5, Number.NaN)).toBe(5);
    expect(coherentOfflineTimeoutSeconds(0, 0)).toBe(1);
  });
});
