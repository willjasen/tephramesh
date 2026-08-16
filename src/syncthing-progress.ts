import type { SyncthingFolderStatus } from "./model";

export function syncProgress(folder: SyncthingFolderStatus): number | undefined {
  const globalBytes = folder.globalBytes;
  if (Number.isFinite(globalBytes) && globalBytes! > 0) {
    return percentage(globalBytes! - folder.needBytes, globalBytes!);
  }

  if (Number.isFinite(folder.globalFiles) && folder.globalFiles > 0) {
    return percentage(folder.globalFiles - folder.needFiles, folder.globalFiles);
  }

  if (folder.needBytes === 0 && folder.needFiles === 0) return 100;
  return undefined;
}

function percentage(completed: number, total: number): number {
  return Math.floor(Math.max(0, Math.min(1, completed / total)) * 100);
}
