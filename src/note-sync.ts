export function pendingFolderPaths(notePaths: Iterable<string>): Set<string> {
  const folders = new Set<string>();
  for (const notePath of notePaths) {
    const parts = notePath.replaceAll("\\", "/").split("/");
    parts.pop();
    for (let depth = 1; depth <= parts.length; depth += 1) {
      folders.add(parts.slice(0, depth).join("/"));
    }
  }
  folders.delete("");
  return folders;
}
