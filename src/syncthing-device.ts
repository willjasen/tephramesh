import type { SyncthingDevice } from "./model";

export function localSyncthingDeviceName(
  devices: SyncthingDevice[],
  localDeviceId: string,
): string | null {
  const name = devices
    .find((device) => device.deviceID === localDeviceId)
    ?.name.trim();
  return name || null;
}
