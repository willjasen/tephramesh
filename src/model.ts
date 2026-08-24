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
  shardEncryptionKeyHash: string;
  pollIntervalSeconds: number;
  noteSyncPollIntervalSeconds: number;
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
  untrusted: boolean;
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
  deviceId?: string;
  folder?: SyncthingFolderStatus;
  folderPaused?: boolean;
  pendingFiles?: string[];
  traffic?: SyncthingTrafficSample;
  downloadBytesPerSecond?: number;
  uploadBytesPerSecond?: number;
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
  managedIgnoreRules: ["// always ignore .DS_Store", "(?d).DS_Store"],
  shardEncryptionKeyHash: "",
  pollIntervalSeconds: 1,
  noteSyncPollIntervalSeconds: 5,
  instances: [],
  knownDevices: [],
};
