import { formatDataSize, formatFileSize, formatFolderUpdatedAt } from "../src/format";
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

describe("formatFolderUpdatedAt", () => {
  const now = new Date(2026, 7, 28, 15, 30);

  it("shows only the local time when the update occurred today", () => {
    const updated = new Date(2026, 7, 28, 9, 5);
    expect(formatFolderUpdatedAt(updated.toISOString(), now)).toBe(updated.toLocaleTimeString());
  });

  it("shows the local date and time for an earlier date", () => {
    const updated = new Date(2026, 7, 27, 23, 55);
    expect(formatFolderUpdatedAt(updated.toISOString(), now)).toBe(updated.toLocaleString());
  });

  it("preserves unknown and invalid values", () => {
    expect(formatFolderUpdatedAt(undefined, now)).toBe("unknown");
    expect(formatFolderUpdatedAt("not-a-date", now)).toBe("not-a-date");
  });
});
