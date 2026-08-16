import type { SyncthingTrafficSample } from "./model";

export interface SyncthingTrafficRates {
  downloadBytesPerSecond?: number;
  uploadBytesPerSecond?: number;
}

export function trafficRates(
  previous: SyncthingTrafficSample | undefined,
  current: SyncthingTrafficSample,
): SyncthingTrafficRates {
  if (!previous) return {};
  const elapsedSeconds = (current.sampledAt - previous.sampledAt) / 1_000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return {};
  return {
    downloadBytesPerSecond: rate(
      current.inBytesTotal - previous.inBytesTotal,
      elapsedSeconds,
    ),
    uploadBytesPerSecond: rate(
      current.outBytesTotal - previous.outBytesTotal,
      elapsedSeconds,
    ),
  };
}

export function formatTransferRate(bytesPerSecond: number | undefined): string {
  if (bytesPerSecond === undefined) return "measuring…";
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function rate(delta: number, elapsedSeconds: number): number | undefined {
  if (!Number.isFinite(delta) || delta < 0) return undefined;
  return delta / elapsedSeconds;
}
