import { describe, expect, it, vi } from "vitest";
import {
  collectNeededFileNames,
  MAX_NEEDED_FILE_PAGES,
  NEEDED_FILES_PER_PAGE,
} from "../src/syncthing-pagination";

describe("needed-file pagination", () => {
  it("collects bounded pages until the final partial page", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({
        files: Array.from(
          { length: NEEDED_FILES_PER_PAGE },
          (_, index) => ({ name: `full-${index}.md` }),
        ),
      })
      .mockResolvedValueOnce({ files: [{ name: "last.md" }] });

    const names = await collectNeededFileNames(fetchPage, ["files"]);

    expect(names).toHaveLength(NEEDED_FILES_PER_PAGE + 1);
    expect(names.at(-1)).toBe("last.md");
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("rejects repeated full pages", async () => {
    const repeated = {
      files: Array.from(
        { length: NEEDED_FILES_PER_PAGE },
        (_, index) => ({ name: `same-${index}.md` }),
      ),
    };
    const fetchPage = vi.fn().mockResolvedValue(repeated);

    await expect(collectNeededFileNames(fetchPage, ["files"]))
      .rejects.toThrow(/repeated/i);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed needed-file pages", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      progress: [],
      queued: [{ path: "missing-name.md" }],
      rest: [],
    });

    await expect(
      collectNeededFileNames(fetchPage, ["progress", "queued", "rest"]),
    ).rejects.toThrow(/invalid needed-file path/i);
  });

  it("rejects pages larger than the requested page size", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      files: Array.from(
        { length: NEEDED_FILES_PER_PAGE + 1 },
        (_, index) => ({ name: `oversized-${index}.md` }),
      ),
    });

    await expect(collectNeededFileNames(fetchPage, ["files"]))
      .rejects.toThrow(/too many/i);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("stops at the configured page limit", async () => {
    const fetchPage = vi.fn().mockImplementation((page: number) =>
      Promise.resolve({
        files: Array.from(
          { length: NEEDED_FILES_PER_PAGE },
          (_, index) => ({ name: `${page}-${index}.md` }),
        ),
      }),
    );

    await expect(collectNeededFileNames(fetchPage, ["files"]))
      .rejects.toThrow(/safety limit/i);
    expect(fetchPage).toHaveBeenCalledTimes(MAX_NEEDED_FILE_PAGES);
  });
});
