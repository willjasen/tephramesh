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

export function pendingNotePathsForHostThreshold(
  neededByHost: Iterable<Iterable<string>>,
  hostCount: number,
  requiredHosts: number,
): Set<string> {
  const neededCounts = new Map<string, number>();
  for (const paths of neededByHost) {
    for (const rawPath of new Set(paths)) {
      const path = rawPath.replaceAll("\\", "/");
      if (path.toLowerCase().endsWith(".md")) {
        neededCounts.set(path, (neededCounts.get(path) ?? 0) + 1);
      }
    }
  }
  const threshold = Math.max(1, Math.min(requiredHosts, hostCount));
  return new Set(
    [...neededCounts].filter(([, needed]) => hostCount - needed < threshold).map(([path]) => path),
  );
}
