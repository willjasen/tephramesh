export type InstanceKind = "device" | "shard";
export interface KnownDevice {
  deviceId: string;
  name: string;
}
export type Protocol = "http" | "https";
export type SyncthingPullOrder = "random" | "alphabetic" | "smallestFirst" | "largestFirst" | "oldestFirst" | "newestFirst";

export interface Endpoint {
  protocol: Protocol;
  hostname: string;
  port: number;
  path?: string;
}

export interface MeshInstance {
  id: string;
  /** Persisted display position in the Instances settings tab. */
  displayOrder?: number;
  name: string;
  kind: InstanceKind;
  endpoint: Endpoint;
  deviceId: string;
  folderPath: string;
  pullOrder?: SyncthingPullOrder;
  setupState?: "pending";
}

export interface TephrameshSettings {
  schemaVersion: 3;
  ageRecipient: string;
  onboardingComplete: boolean;
  primaryInstanceId: string;
  folderId: string;
  folderLabel: string;
  managedIgnoreRules: string[];
  pollIntervalSeconds: number;
  offlineTimeoutSeconds: number;
  noteSyncPollIntervalSeconds: number;
  noteSyncRequiredHosts: number;
  configHistoryVersions: number;
  instances: MeshInstance[];
  knownDevices: KnownDevice[];
}

export interface SyncthingSystemStatus {
  myID: string;
  uptime: number;
}

export interface SyncthingVersion {
  version: string;
  longVersion?: string;
  os?: string;
}

export interface SyncthingFolderDevice {
  deviceID: string;
  introducedBy?: string;
  encryptionPassword?: string;
}

export interface SyncthingFolder {
  id: string;
  label: string;
  path: string;
  type: string;
  paused?: boolean;
  devices: SyncthingFolderDevice[];
  [key: string]: unknown;
}

export interface SyncthingDevice {
  deviceID: string;
  name: string;
  addresses: string[];
  compression?: string;
  introducer?: boolean;
  skipIntroductionRemovals?: boolean;
  paused?: boolean;
  autoAcceptFolders?: boolean;
  /** Undefined means Tephramesh deliberately leaves Syncthing's trust choice unchanged. */
  untrusted?: boolean;
  [key: string]: unknown;
}

export interface SyncthingFolderStatus {
  state: string;
  stateChanged?: string;
  localFiles: number;
  globalFiles: number;
  localBytes?: number;
  globalBytes?: number;
  needFiles: number;
  needBytes: number;
  inSyncFiles?: number;
  errors?: number;
  pullErrors?: number;
  scanProgress?: number;
}

export interface SyncthingFolderScanProgressEvent {
  id: number;
  time: string;
  type: "FolderScanProgress";
  data: {
    folder: string;
    current: number;
    total: number;
    rate: number;
  };
}

export interface SyncthingNeededFile {
  name: string;
}

export interface SyncthingRemoteNeed {
  files: SyncthingNeededFile[];
  page: number;
  perpage: number;
}

export interface SyncthingLocalNeed {
  progress: SyncthingNeededFile[];
  queued: SyncthingNeededFile[];
  rest: SyncthingNeededFile[];
  page: number;
  perpage: number;
}

export interface InstanceRuntimeStatus {
  checkedAt: number;
  ok: boolean;
  error?: string;
  version?: string;
  operatingSystem?: string;
  deviceId?: string;
  folder?: SyncthingFolderStatus;
  folderPaused?: boolean;
  pendingFiles?: string[];
  traffic?: SyncthingTrafficSample;
  downloadBytesPerSecond?: number;
  uploadBytesPerSecond?: number;
}

export function normalizeInstanceDisplayOrder(instances: unknown): MeshInstance[] {
  if (!Array.isArray(instances)) return [];
  return instances.map((instance, index) => ({
    ...(instance as MeshInstance),
    displayOrder: Number.isFinite((instance as MeshInstance).displayOrder)
      ? (instance as MeshInstance).displayOrder
      : index,
  }));
}

export interface SyncthingTrafficSample {
  sampledAt: number;
  inBytesTotal: number;
  outBytesTotal: number;
}

export interface SyncthingConnections {
  total: {
    inBytesTotal: number;
    outBytesTotal: number;
  };
}

export const DEFAULT_SETTINGS: TephrameshSettings = {
  schemaVersion: 3,
  ageRecipient: "",
  onboardingComplete: false,
  primaryInstanceId: "",
  folderId: "",
  folderLabel: "Obsidian vault",
  managedIgnoreRules: [],
  pollIntervalSeconds: 1,
  offlineTimeoutSeconds: 5,
  noteSyncPollIntervalSeconds: 5,
  noteSyncRequiredHosts: 0,
  configHistoryVersions: 10,
  instances: [],
  knownDevices: [],
};

export function coherentOfflineTimeoutSeconds(
  offlineTimeoutSeconds: number,
  pollIntervalSeconds: number,
): number {
  const offline = Number.isFinite(offlineTimeoutSeconds)
    ? Math.max(1, Math.floor(offlineTimeoutSeconds))
    : DEFAULT_SETTINGS.offlineTimeoutSeconds;
  const polling = Number.isFinite(pollIntervalSeconds)
    ? Math.max(1, Math.floor(pollIntervalSeconds))
    : DEFAULT_SETTINGS.pollIntervalSeconds;
  return Math.max(offline, polling);
}
