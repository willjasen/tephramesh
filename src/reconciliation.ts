import type {
  MeshInstance,
  SyncthingDevice,
  SyncthingFolder,
  SyncthingFolderStatus,
} from "./model";
import { meshPeerPolicy } from "./topology";

export type ReconciliationState =
  | "checking"
  | "healthy"
  | "issues"
  | "unavailable"
  | "repairing";

export interface ReconciliationIssue {
  instanceId: string;
  instanceName: string;
  message: string;
  repairable: boolean;
}

export interface ReconciliationReport {
  state: ReconciliationState;
  checkedAt?: number;
  issues: ReconciliationIssue[];
  repairBlockedReasons: string[];
}

export interface InstanceReconciliationSnapshot {
  instance: MeshInstance;
  reportedDeviceId: string;
  devices: SyncthingDevice[];
  folders: SyncthingFolder[];
  folderStatus?: SyncthingFolderStatus;
  pendingDeviceIds: string[];
  pendingFolderIds: string[];
}

function normalizedPath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function issue(
  snapshot: InstanceReconciliationSnapshot,
  message: string,
  repairable: boolean,
): ReconciliationIssue {
  return {
    instanceId: snapshot.instance.id,
    instanceName: snapshot.instance.name,
    message,
    repairable,
  };
}

export function inspectReconciliationSnapshot(
  snapshot: InstanceReconciliationSnapshot,
  activeInstances: MeshInstance[],
  folderId: string,
  folderLabel: string,
  shardEncryptionKey: string,
): ReconciliationIssue[] {
  const { instance } = snapshot;
  const issues: ReconciliationIssue[] = [];
  if (snapshot.reportedDeviceId !== instance.deviceId) {
    issues.push(
      issue(snapshot, "The API reports a different Syncthing device ID.", false),
    );
    return issues;
  }

  const expectedPath = normalizedPath(instance.folderPath);
  const folder = snapshot.folders.find((candidate) => candidate.id === folderId);
  const pathOwner = snapshot.folders.find(
    (candidate) => normalizedPath(candidate.path) === expectedPath,
  );
  if (!folder && pathOwner) {
    issues.push(
      issue(
        snapshot,
        `The configured path belongs to Syncthing folder “${pathOwner.id}”.`,
        false,
      ),
    );
  } else if (!folder) {
    issues.push(issue(snapshot, "The managed folder is missing.", true));
  } else {
    if (normalizedPath(folder.path) !== expectedPath) {
      issues.push(
        issue(snapshot, "The managed folder uses an unexpected path.", false),
      );
    }
    const expectedType =
      instance.kind === "shard" ? "receiveencrypted" : "sendreceive";
    if (folder.type !== expectedType) {
      issues.push(
        issue(
          snapshot,
          `The managed folder type is “${folder.type}”; expected “${expectedType}”.`,
          false,
        ),
      );
    }
    if (folder.label !== folderLabel) {
      issues.push(issue(snapshot, "The managed folder label has drifted.", true));
    }
  }

  for (const peer of activeInstances) {
    if (peer.id === instance.id) continue;
    const policy = meshPeerPolicy(instance, peer, shardEncryptionKey);
    const configuredPeer = snapshot.devices.find(
      (candidate) => candidate.deviceID === peer.deviceId,
    );
    if (!configuredPeer) {
      issues.push(
        issue(snapshot, `Peer device “${peer.name}” is missing.`, true),
      );
    } else {
      if (configuredPeer.untrusted !== policy.untrusted) {
        issues.push(
          issue(snapshot, `Peer trust for “${peer.name}” is incorrect.`, true),
        );
      }
      if (configuredPeer.name !== peer.name) {
        issues.push(
          issue(snapshot, `Peer name for “${peer.name}” is out of date.`, true),
        );
      }
    }

    if (folder) {
      const folderPeer = folder.devices.find(
        (candidate) => candidate.deviceID === peer.deviceId,
      );
      if (!folderPeer) {
        issues.push(
          issue(snapshot, `The folder is not shared with “${peer.name}”.`, true),
        );
      } else if (
        (folderPeer.encryptionPassword ?? "") !== policy.encryptionPassword
      ) {
        issues.push(
          issue(
            snapshot,
            `The folder encryption setting for “${peer.name}” is incorrect.`,
            true,
          ),
        );
      }
    }
  }

  if (folder) {
    const expectedDeviceIds = new Set(
      activeInstances.map((candidate) => candidate.deviceId),
    );
    for (const folderPeer of folder.devices) {
      if (!expectedDeviceIds.has(folderPeer.deviceID)) {
        issues.push(
          issue(
            snapshot,
            `The managed folder is shared with unregistered device ${folderPeer.deviceID}.`,
            true,
          ),
        );
      }
    }
  }

  for (const pendingDeviceId of snapshot.pendingDeviceIds) {
    const peer = activeInstances.find(
      (candidate) => candidate.deviceId === pendingDeviceId,
    );
    if (peer && peer.id !== instance.id) {
      issues.push(
        issue(snapshot, `A device invitation from “${peer.name}” is pending.`, true),
      );
    }
  }
  if (snapshot.pendingFolderIds.includes(folderId)) {
    issues.push(issue(snapshot, "A managed-folder invitation is pending.", true));
  }

  return issues;
}

export function repairBlockedReasons(
  snapshots: InstanceReconciliationSnapshot[],
): string[] {
  const reasons: string[] = [];
  for (const snapshot of snapshots) {
    const managedFolder = snapshot.folders.find(
      (folder) =>
        normalizedPath(folder.path) === normalizedPath(snapshot.instance.folderPath),
    );
    if (managedFolder?.paused) {
      reasons.push(`${snapshot.instance.name}'s managed folder must be resumed.`);
      continue;
    }
    const status = snapshot.folderStatus;
    if (!status) continue;
    const errors = (status.errors ?? 0) + (status.pullErrors ?? 0);
    if (
      status.state !== "idle" ||
      status.needFiles > 0 ||
      status.needBytes > 0 ||
      errors > 0
    ) {
      reasons.push(`${snapshot.instance.name} must be idle and fully synchronized.`);
    }
  }
  return reasons;
}
