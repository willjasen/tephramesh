import { describe, expect, it } from "vitest";
import { notePartialScanPath } from "../src/note-scan";

describe("notePartialScanPath", () => {
  it("normalizes Markdown note paths for Syncthing", () => {
    expect(notePartialScanPath("Projects\\Plan.MD")).toBe("Projects/Plan.MD");
    expect(notePartialScanPath("Inbox.md")).toBe("Inbox.md");
  });

  it("rejects non-Markdown and unsafe relative paths", () => {
    expect(notePartialScanPath("Attachments/image.png")).toBeUndefined();
    expect(notePartialScanPath("../outside.md")).toBeUndefined();
    expect(notePartialScanPath("/outside.md")).toBeUndefined();
    expect(notePartialScanPath("Folder//Note.md")).toBeUndefined();
  });
});
