import { formatDataSize } from "../src/format";
import { describe, expect, it } from "vitest";

describe("formatDataSize", () => {
  it("formats megabytes and gigabytes", () => {
    expect(formatDataSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatDataSize(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });

  it("returns undefined for unavailable values", () => {
    expect(formatDataSize(undefined)).toBeUndefined();
    expect(formatDataSize(Number.NaN)).toBeUndefined();
  });
});
