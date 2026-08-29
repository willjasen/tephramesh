import { formatDataSize, formatFileSize } from "../src/format";
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

describe("formatFileSize", () => {
  it("uses a readable unit for small configuration files", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(12 * 1024)).toBe("12.0 KB");
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("returns undefined for unavailable values", () => {
    expect(formatFileSize(undefined)).toBeUndefined();
    expect(formatFileSize(-1)).toBeUndefined();
  });
});
