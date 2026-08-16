import type {
  InstanceRuntimeStatus,
  MeshInstance,
  SyncthingDevice,
  SyncthingFolder,
  SyncthingFolderDevice,
} from "./model";

export type MeshRuntimeState = "idle" | "scanning" | "syncing" | "checking" | "unavailable";

export function meshRuntimeState(
  statuses: Array<InstanceRuntimeStatus | undefined>,
): MeshRuntimeState {
  if (statuses.some((status) => status && !status.ok)) return "unavailable";
  if (statuses.length === 0 || statuses.some((status) => !status?.folder)) {
    return "checking";
  }
  if (statuses.some((status) => status?.folder?.state === "scanning")) {
    return "scanning";
  }
  if (statuses.some((status) => status?.folder?.state === "syncing")) {
    return "syncing";
  }
  if (statuses.every((status) => status?.folder?.state === "idle")) return "idle";
  return "checking";
}

export interface PlannedInstanceConfig {
  instanceId: string;
  devices: SyncthingDevice[];
  folder: SyncthingFolder;
}

export interface MeshPlan {
  folderId: string;
  instances: PlannedInstanceConfig[];
  edgeCount: number;
}

export interface MeshPeerPolicy {
  untrusted: boolean;
  encryptionPassword: string;
}

export function meshPeerPolicy(
  local: MeshInstance,
  remote: MeshInstance,
  shardKey: string,
): MeshPeerPolicy {
  const trustedDeviceToShard = local.kind === "device" && remote.kind === "shard";
  return {
    untrusted: trustedDeviceToShard,
    encryptionPassword: trustedDeviceToShard ? shardKey : "",
  };
}

function requireCompleteInstances(instances: MeshInstance[]): void {
  const ids = new Set<string>();
  const deviceIds = new Set<string>();
  for (const instance of instances) {
    if (!instance.id || ids.has(instance.id)) throw new Error("Instance IDs must be unique.");
    if (!instance.deviceId || deviceIds.has(instance.deviceId)) {
      throw new Error("Every instance must have a unique Syncthing device ID.");
    }
    if (!instance.folderPath) throw new Error(`${instance.name} needs a folder path.`);
    ids.add(instance.id);
    deviceIds.add(instance.deviceId);
  }
}

export function createMeshPlan(
  instances: MeshInstance[],
  folderId: string,
  folderLabel: string,
  shardPassword: string,
): MeshPlan {
  requireCompleteInstances(instances);
  if (!folderId.trim()) throw new Error("A Syncthing folder ID is required.");
  if (instances.some((instance) => instance.kind === "shard") && !shardPassword) {
    throw new Error("A shard encryption key is required when the mesh has shards.");
  }

  const plans = instances.map((local): PlannedInstanceConfig => {
    const devices: SyncthingDevice[] = instances.map((remote) => {
      const policy = meshPeerPolicy(local, remote, shardPassword);
      return {
        deviceID: remote.deviceId,
        name: remote.name,
        addresses: ["dynamic"],
        compression: "metadata",
        introducer: false,
        skipIntroductionRemovals: false,
        paused: false,
        autoAcceptFolders: false,
        untrusted: policy.untrusted,
      };
    });

    const folderDevices: SyncthingFolderDevice[] = instances.map((remote) => {
      const policy = meshPeerPolicy(local, remote, shardPassword);
      return {
        deviceID: remote.deviceId,
        introducedBy: "",
        encryptionPassword: policy.encryptionPassword,
      };
    });

    const folder: SyncthingFolder = {
      id: folderId,
      label: folderLabel,
      path: local.folderPath,
      type: local.kind === "shard" ? "receiveencrypted" : "sendreceive",
      paused: false,
      devices: folderDevices,
    };
    return { instanceId: local.id, devices, folder };
  });

  return {
    folderId,
    instances: plans,
    edgeCount: (instances.length * (instances.length - 1)) / 2,
  };
}
