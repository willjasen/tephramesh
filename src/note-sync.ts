export function noteSyncPollIntervalMilliseconds(seconds: number): number {
  return Math.max(0.5, seconds) * 1000;
}

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
  return new Set(
    pendingNoteMissingHostsForThreshold(neededByHost, hostCount, requiredHosts).keys(),
  );
}

export function pendingNoteMissingHostsForThreshold(
  neededByHost: Iterable<Iterable<string>>,
  hostCount: number,
  requiredHosts: number,
): Map<string, Set<number>> {
  const missingHosts = new Map<string, Set<number>>();
  let hostIndex = 0;
  for (const paths of neededByHost) {
    for (const rawPath of new Set(paths)) {
      const path = rawPath.replaceAll("\\", "/");
      if (path.toLowerCase().endsWith(".md")) {
        const hosts = missingHosts.get(path) ?? new Set<number>();
        hosts.add(hostIndex);
        missingHosts.set(path, hosts);
      }
    }
    hostIndex += 1;
  }
  const threshold = Math.max(1, Math.min(requiredHosts, hostCount));
  return new Map(
    [...missingHosts].filter(([, hosts]) => hostCount - hosts.size < threshold),
  );
}

export function pendingFolderMissingHosts(
  noteMissingHosts: ReadonlyMap<string, ReadonlySet<number>>,
): Map<string, Set<number>> {
  const folders = new Map<string, Set<number>>();
  for (const [notePath, missingHosts] of noteMissingHosts) {
    for (const folderPath of pendingFolderPaths([notePath])) {
      const hosts = folders.get(folderPath) ?? new Set<number>();
      for (const host of missingHosts) hosts.add(host);
      folders.set(folderPath, hosts);
    }
  }
  return folders;
}
