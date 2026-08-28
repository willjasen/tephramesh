import { describe, expect, it } from "vitest";
import { pendingFolderPaths, pendingNotePathsForHostThreshold } from "../src/note-sync";

describe("pendingNotePathsForHostThreshold", () => {
  it("clears a note once it is available on the required hosts", () => {
    expect(pendingNotePathsForHostThreshold([["a.md"], [], ["b.md"], ["b.md"]], 4, 3)).toEqual(new Set(["b.md"]));
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
});
