import type {
  InstanceRuntimeStatus,
  MeshInstance,
  SyncthingDevice,
  SyncthingFolder,
  SyncthingFolderDevice,
} from "./model";

export type MeshRuntimeState = "idle" | "scanning" | "syncing" | "checking" | "unavailable" | "pending";
export type KnownDeviceRuntimeState = "online" | "offline" | "unavailable";
export type InstanceIndicatorState = "online" | "warning" | "scanning" | "syncing" | "unavailable";
export type MeshStatusBarState = "ready" | "scanning" | "syncing" | "warning" | "error";

export interface MeshStatusBarPresentation {
  state: MeshStatusBarState;
  label: string;
}

export function meshStatusBarPresentation(
  instances: MeshInstance[],
  statuses: ReadonlyMap<string, InstanceRuntimeStatus>,
  timeoutSeconds: number,
): MeshStatusBarPresentation {
  if (instances.length === 0) {
    return { state: "warning", label: "Tephramesh: setup required" };
  }

  const unavailable = instances.filter((instance) => {
    const status = statuses.get(instance.id);
    return Boolean(status && !isRuntimeStatusFresh(status, timeoutSeconds));
  });
  if (unavailable.length > 0) {
    return {
      state: "error",
      label: `Tephramesh: connection ${unavailable.length === 1 ? "error" : "errors"} — ${unavailable.map((instance) => instance.name).join(", ")}`,
    };
  }

  const unchecked = instances.filter((instance) => !statuses.has(instance.id));
  const pending = instances.filter((instance) => instance.setupState === "pending");
  const paused = instances.filter((instance) => statuses.get(instance.id)?.folderPaused);
  const incomplete = [...new Map(
    [...unchecked, ...pending, ...paused].map((instance) => [instance.id, instance]),
  ).values()];
  if (incomplete.length > 0) {
    return {
      state: "warning",
      label: `Tephramesh: waiting — ${incomplete.map((instance) => instance.name).join(", ")}`,
    };
  }

  const freshStatuses = instances.map((instance) => statuses.get(instance.id));
  if (freshStatuses.some((status) => status?.folder?.state === "scanning")) {
    return { state: "scanning", label: "Tephramesh: scanning vault" };
  }
  if (freshStatuses.some((status) => isSyncthingSyncState(status?.folder?.state))) {
    return { state: "syncing", label: "Tephramesh: syncing vault" };
  }
  if (freshStatuses.every((status) => status?.folder?.state === "idle")) {
    return {
      state: "ready",
      label: `Tephramesh: up to date — ${instances.length} ${instances.length === 1 ? "instance" : "instances"} connected`,
    };
  }
  return { state: "warning", label: "Tephramesh: checking mesh status" };
}

export function instanceIndicatorState(
  instance: MeshInstance,
  status: InstanceRuntimeStatus | undefined,
  timeoutSeconds: number,
): InstanceIndicatorState {
  if (instance.setupState === "pending" || status?.folderPaused) return "warning";
  if (!status) return "warning";
  if (status && !isRuntimeStatusFresh(status, timeoutSeconds)) return "unavailable";
  if (status?.folder?.state === "scanning") return "scanning";
  if (isSyncthingSyncState(status?.folder?.state)) return "syncing";
  return "online";
}

export function instancesIndicatorState(
  instances: MeshInstance[],
  statuses: ReadonlyMap<string, InstanceRuntimeStatus>,
  timeoutSeconds: number,
): InstanceIndicatorState {
  const states = instances.map((instance) =>
    instanceIndicatorState(instance, statuses.get(instance.id), timeoutSeconds),
  );
  if (states.includes("unavailable")) return "unavailable";
  if (states.includes("warning")) return "warning";
  if (states.includes("scanning")) return "scanning";
  if (states.includes("syncing")) return "syncing";
  return "online";
}

export function knownDeviceRuntimeState(
  deviceId: string,
  instances: MeshInstance[],
  statuses: ReadonlyMap<string, InstanceRuntimeStatus>,
  timeoutSeconds: number,
  preferredInstanceId?: string,
  excludedDeviceId?: string,
): KnownDeviceRuntimeState {
  const onlineDeviceStatuses = activeMeshInstances(instances)
    .filter((instance) => instance.kind === "device" && instance.deviceId !== excludedDeviceId)
    .flatMap((instance) => {
      const status = statuses.get(instance.id);
      return isRuntimeStatusFresh(status, timeoutSeconds)
        ? [{ instanceId: instance.id, status: status! }]
        : [];
    });
  if (onlineDeviceStatuses.length === 0) return "unavailable";
  const preferred = onlineDeviceStatuses.find(({ instanceId }) => instanceId === preferredInstanceId);
  if (preferred) {
    return preferred.status.peerConnections?.[deviceId] === true ? "online" : "offline";
  }
  return onlineDeviceStatuses.some(({ status }) => status.peerConnections?.[deviceId] === true)
    ? "online"
    : "offline";
}

export function activeMeshInstances(instances: MeshInstance[]): MeshInstance[] {
  return instances.filter((instance) => instance.setupState !== "pending");
}

export function unavailableInstancesSummary(
  configured: MeshInstance[],
  operating: MeshInstance[],
): string {
  const operatingIds = new Set(operating.map((instance) => instance.id));
  const counts = new Map<MeshInstance["kind"], number>();
  for (const instance of configured) {
    if (!operatingIds.has(instance.id)) counts.set(instance.kind, (counts.get(instance.kind) ?? 0) + 1);
  }
  const parts = (["device", "shard"] as const)
    .filter((kind) => counts.has(kind))
    .map((kind) => `${counts.get(kind)} ${kind}${counts.get(kind) === 1 ? "" : "s"}`);
  return `${parts.join(" and ")} unavailable.`;
}

export function topologyHealthState(
  configured: MeshInstance[],
  operating: MeshInstance[],
): "healthy" | "warning" {
  return configured.length === operating.length ? "healthy" : "warning";
}

export function unavailableStatusIsTolerated(requiredHosts: number, activeHostCount: number): boolean {
  return requiredHosts < activeHostCount;
}

export function unavailableInstanceLabels(
  configured: MeshInstance[],
  operating: MeshInstance[],
): string[] {
  const operatingIds = new Set(operating.map((instance) => instance.id));
  return configured
    .filter((instance) => !operatingIds.has(instance.id))
    .map((instance) => `${instance.kind === "device" ? "Device" : "Shard"}: ${instance.name}`);
}

export function canRemoveInstance(
  instances: MeshInstance[],
  instance: MeshInstance,
): boolean {
  if (instance.kind === "shard") return true;
  return activeMeshInstances(instances).some(
    (candidate) => candidate.kind === "device" && candidate.id !== instance.id,
  );
}

export function isSyncthingSyncState(state: string | undefined): boolean {
  return state === "syncing" || state === "sync-preparing" || state === "sync-waiting";
}

export function isRuntimeStatusFresh(status: InstanceRuntimeStatus | undefined, timeoutSeconds?: number, now = Date.now()): boolean {
  return Boolean(status?.ok) && (timeoutSeconds === undefined || now - (status?.checkedAt ?? 0) <= Math.max(1, timeoutSeconds) * 1000);
}

export function meshRuntimeStates(
  instances: MeshInstance[],
  statuses: ReadonlyMap<string, InstanceRuntimeStatus>,
  timeoutSeconds?: number,
): MeshRuntimeState[] {
  const activeState = meshRuntimeState(
    activeMeshInstances(instances).map((instance) => {
      const status = statuses.get(instance.id);
      return isRuntimeStatusFresh(status, timeoutSeconds) ? status : status ? { ...status, ok: false } : undefined;
    }),
  );
  return instances.some((instance) => instance.setupState === "pending")
    ? [activeState, "pending"]
    : [activeState];
}

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
  if (statuses.some((status) => isSyncthingSyncState(status?.folder?.state))) {
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
  /** Undefined means peer trust is managed by Syncthing/the operator, not Tephramesh. */
  untrusted?: boolean;
  encryptionPassword: string;
}

export function meshPeerPolicy(
  local: MeshInstance,
  remote: MeshInstance,
  shardKey: string,
): MeshPeerPolicy {
  const involvesShard = local.kind === "shard" || remote.kind === "shard";
  const trustedDeviceToShard = local.kind === "device" && remote.kind === "shard";
  return {
    // A shard can also host ordinary folders. Do not change its peer-trust setting
    // when creating or reconciling this managed share.
    untrusted: involvesShard ? undefined : false,
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
