export const NEEDED_FILES_PER_PAGE = 1000;
export const MAX_NEEDED_FILE_PAGES = 100;
export const MAX_NEEDED_FILE_PATHS =
  NEEDED_FILES_PER_PAGE * MAX_NEEDED_FILE_PAGES;

export async function collectNeededFileNames(
  fetchPage: (page: number) => Promise<unknown>,
  fields: string[],
): Promise<string[]> {
  const names: string[] = [];
  let previousFullPageSignature: string | undefined;
  for (let page = 1; page <= MAX_NEEDED_FILE_PAGES; page += 1) {
    const pageNames = parseNeededFileNames(await fetchPage(page), fields);
    if (pageNames.length > NEEDED_FILES_PER_PAGE) {
      throw new Error("Syncthing returned too many needed-file paths in one page.");
    }
    if (names.length + pageNames.length > MAX_NEEDED_FILE_PATHS) {
      throw new Error(
        "Syncthing needed-file results exceed Tephramesh's safety limit.",
      );
    }
    const signature = JSON.stringify(pageNames);
    if (
      pageNames.length === NEEDED_FILES_PER_PAGE &&
      signature === previousFullPageSignature
    ) {
      throw new Error(
        "Syncthing repeated a needed-file page instead of advancing pagination.",
      );
    }
    names.push(...pageNames);
    if (pageNames.length < NEEDED_FILES_PER_PAGE) return names;
    if (page === MAX_NEEDED_FILE_PAGES) {
      throw new Error(
        "Syncthing needed-file results exceed Tephramesh's safety limit.",
      );
    }
    previousFullPageSignature = signature;
  }
  throw new Error("Syncthing needed-file pagination did not complete.");
}

function parseNeededFileNames(response: unknown, fields: string[]): string[] {
  if (!response || typeof response !== "object") {
    throw new Error("Syncthing returned an invalid needed-file page.");
  }
  const record = response as Record<string, unknown>;
  const names: string[] = [];
  for (const field of fields) {
    const files = record[field];
    if (!Array.isArray(files)) {
      throw new Error("Syncthing returned an invalid needed-file page.");
    }
    for (const file of files) {
      if (
        !file ||
        typeof file !== "object" ||
        typeof (file as { name?: unknown }).name !== "string"
      ) {
        throw new Error("Syncthing returned an invalid needed-file path.");
      }
      names.push((file as { name: string }).name);
    }
  }
  return names;
}
