import { describe, expect, it } from "vitest";
import {
  folderStatusHasPendingItems,
  remoteCompletionHasPendingItems,
} from "../src/syncthing-completion";

describe("remote folder completion", () => {
  it("treats zero pending items and deletes as complete", () => {
    expect(remoteCompletionHasPendingItems({ needItems: 0, needDeletes: 0 })).toBe(false);
  });

  it("retains file enumeration when items or deletes remain", () => {
    expect(remoteCompletionHasPendingItems({ needItems: 1, needDeletes: 0 })).toBe(true);
    expect(remoteCompletionHasPendingItems({ needItems: 0, needDeletes: 1 })).toBe(true);
  });

  it("falls back when Syncthing omits completion counters", () => {
    expect(remoteCompletionHasPendingItems({ completion: 100 })).toBeUndefined();
  });
});

describe("local folder status", () => {
  it("is authoritative when a Shard reports nothing pending", () => {
    expect(folderStatusHasPendingItems({ needFiles: 0, needBytes: 0, needDeletes: 0 })).toBe(false);
  });

  it("detects pending files, bytes, and deletes", () => {
    expect(folderStatusHasPendingItems({ needFiles: 1, needBytes: 0 })).toBe(true);
    expect(folderStatusHasPendingItems({ needFiles: 0, needBytes: 1 })).toBe(true);
    expect(folderStatusHasPendingItems({ needFiles: 0, needBytes: 0, needDeletes: 1 })).toBe(true);
  });
});
