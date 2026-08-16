import { describe, expect, it } from "vitest";
import type { SyncthingFolderScanProgressEvent } from "../src/model";
import {
  latestFolderScanProgress,
  scanProgressPercentage,
} from "../src/syncthing-scan";

describe("Syncthing scan progress", () => {
  it("calculates and clamps a whole-number percentage", () => {
    expect(scanProgressPercentage(25, 100)).toBe(25);
    expect(scanProgressPercentage(2, 3)).toBe(67);
    expect(scanProgressPercentage(120, 100)).toBe(100);
    expect(scanProgressPercentage(1, 0)).toBe(0);
  });

  it("uses the latest event for the folder from the current scan", () => {
    const events: SyncthingFolderScanProgressEvent[] = [
      {
        id: 1,
        type: "FolderScanProgress",
        time: "2026-08-15T22:00:00Z",
        data: { folder: "vault", current: 90, total: 100, rate: 1 },
      },
      {
        id: 2,
        type: "FolderScanProgress",
        time: "2026-08-15T22:10:01Z",
        data: { folder: "vault", current: 40, total: 100, rate: 1 },
      },
    ];
    expect(
      latestFolderScanProgress(events, "vault", "2026-08-15T22:10:00Z"),
    ).toBe(40);
    expect(
      latestFolderScanProgress(events, "other", "2026-08-15T22:10:00Z"),
    ).toBeUndefined();
  });
});
