import { describe, expect, it } from "vitest";
import { pendingFolderPaths } from "../src/note-sync";

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
