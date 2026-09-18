export interface SyncthingFolderCompletion {
  completion?: number;
  needItems?: number;
  needDeletes?: number;
  needBytes?: number;
  remoteState?: string;
}

export function remoteCompletionHasPendingItems(
  completion: SyncthingFolderCompletion,
): boolean | undefined {
  const needItems = completion.needItems;
  const needDeletes = completion.needDeletes;
  if (!Number.isFinite(needItems) || !Number.isFinite(needDeletes)) return undefined;
  return (needItems ?? 0) > 0 || (needDeletes ?? 0) > 0;
}

export function folderStatusHasPendingItems(status: {
  needFiles: number;
  needBytes: number;
  needDeletes?: number;
}): boolean {
  return status.needFiles > 0 || status.needBytes > 0 || (status.needDeletes ?? 0) > 0;
}
