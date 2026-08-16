import { describe, expect, it } from "vitest";
import type { SyncthingFolderStatus } from "../src/model";
import { syncProgress } from "../src/syncthing-progress";

function folder(overrides: Partial<SyncthingFolderStatus>): SyncthingFolderStatus {
  return {
    state: "syncing",
    localFiles: 0,
    globalFiles: 0,
    needFiles: 0,
    needBytes: 0,
    ...overrides,
  };
}

describe("syncProgress", () => {
  it("prefers byte progress and does not round an incomplete transfer to 100%", () => {
    expect(syncProgress(folder({ globalBytes: 1_000, needBytes: 1 }))).toBe(99);
  });

  it("falls back to file progress when byte totals are unavailable", () => {
    expect(syncProgress(folder({ globalFiles: 26, needFiles: 1 }))).toBe(96);
  });

  it("reports an empty completed folder as 100%", () => {
    expect(syncProgress(folder({}))).toBe(100);
  });
});
