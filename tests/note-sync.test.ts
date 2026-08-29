import { describe, expect, it } from "vitest";
import {
  noteSyncPollIntervalMilliseconds,
  pendingFolderMissingHosts,
  pendingFolderPaths,
  pendingNoteMissingHostsForThreshold,
  pendingNotePathsForHostThreshold,
} from "../src/note-sync";

describe("noteSyncPollIntervalMilliseconds", () => {
  it("uses the independent half-second note icon interval", () => {
    expect(noteSyncPollIntervalMilliseconds(0.5)).toBe(500);
    expect(noteSyncPollIntervalMilliseconds(5)).toBe(5_000);
    expect(noteSyncPollIntervalMilliseconds(0)).toBe(500);
  });
});

describe("pendingNotePathsForHostThreshold", () => {
  it("clears a note once it is available on the required hosts", () => {
    expect(pendingNotePathsForHostThreshold([["a.md"], [], ["b.md"], ["b.md"]], 4, 3)).toEqual(new Set(["b.md"]));
  });

  it("retains the distinct missing hosts for the displayed count", () => {
    expect(
      pendingNoteMissingHostsForThreshold(
        [["Folder/a.md"], ["Folder/a.md", "Folder/b.md"], [], ["Folder/b.md"]],
        4,
        3,
      ),
    ).toEqual(new Map([
      ["Folder/a.md", new Set([0, 1])],
      ["Folder/b.md", new Set([1, 3])],
    ]));
  });
});

describe("pendingFolderPaths", () => {
  it("marks every ancestor folder of pending notes", () => {
    expect(
      pendingFolderPaths([
        "Projects/Tephramesh/Plan.md",
        "Projects/Notes.md",
        "Inbox.md",
      ]),
    ).toEqual(new Set(["Projects", "Projects/Tephramesh"]));
  });

  it("normalizes Syncthing paths and de-duplicates folders", () => {
    expect(
      pendingFolderPaths([
        "Journal\\2026\\Monday.md",
        "Journal/2026/Tuesday.md",
      ]),
    ).toEqual(new Set(["Journal", "Journal/2026"]));
  });

  it("counts each host once when a folder contains multiple pending notes", () => {
    expect(pendingFolderMissingHosts(new Map([
      ["Projects/A.md", new Set([0, 1])],
      ["Projects/Nested/B.md", new Set([1, 2])],
    ]))).toEqual(new Map([
      ["Projects", new Set([0, 1, 2])],
      ["Projects/Nested", new Set([1, 2])],
    ]));
  });
});
