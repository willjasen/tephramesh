import { describe, expect, it } from "vitest";
import { formatTransferRate, trafficRates } from "../src/syncthing-traffic";

describe("Syncthing traffic rates", () => {
  it("derives download and upload rates from consecutive cumulative samples", () => {
    expect(trafficRates(
      { sampledAt: 1_000, inBytesTotal: 1_000, outBytesTotal: 2_000 },
      { sampledAt: 3_000, inBytesTotal: 4_000, outBytesTotal: 3_000 },
    )).toEqual({ downloadBytesPerSecond: 1_500, uploadBytesPerSecond: 500 });
  });

  it("does not report a rate when counters reset", () => {
    expect(trafficRates(
      { sampledAt: 1_000, inBytesTotal: 2_000, outBytesTotal: 2_000 },
      { sampledAt: 2_000, inBytesTotal: 1_000, outBytesTotal: 1_000 },
    )).toEqual({ downloadBytesPerSecond: undefined, uploadBytesPerSecond: undefined });
  });

  it("formats decimal transfer rates", () => {
    expect(formatTransferRate(0)).toBe("0 B/s");
    expect(formatTransferRate(1_500)).toBe("1.50 KB/s");
    expect(formatTransferRate(undefined)).toBe("measuring…");
  });
});
