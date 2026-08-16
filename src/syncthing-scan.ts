import type { SyncthingFolderScanProgressEvent } from "./model";

export function scanProgressPercentage(current: number, total: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}

export function latestFolderScanProgress(
  events: SyncthingFolderScanProgressEvent[],
  folderId: string,
  scanStartedAt?: string,
): number | undefined {
  const startedAt = scanStartedAt ? Date.parse(scanStartedAt) : Number.NEGATIVE_INFINITY;
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === "FolderScanProgress" &&
        candidate.data.folder === folderId &&
        Date.parse(candidate.time) >= startedAt,
    );
  return event
    ? scanProgressPercentage(event.data.current, event.data.total)
    : undefined;
}
