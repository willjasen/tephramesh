import { describe, expect, it } from "vitest";
import type {
  MeshInstance,
  SyncthingDevice,
  SyncthingFolder,
  SyncthingFolderStatus,
} from "../src/model";
import {
  inspectReconciliationSnapshot,
  repairBlockedReasons,
  type InstanceReconciliationSnapshot,
} from "../src/reconciliation";

const endpoint = {
  protocol: "https" as const,
  hostname: "example.com",
  port: 8384,
};
const device: MeshInstance = {
  id: "device",
  name: "Device",
  kind: "device",
  endpoint,
  deviceId: "DEVICE-ID",
  folderPath: "/vault",
};
const shard: MeshInstance = {
  id: "shard",
  name: "Shard",
  kind: "shard",
  endpoint,
  deviceId: "SHARD-ID",
  folderPath: "/encrypted",
};
const key = "sk-abcdefghijklmnopqrstuvwxyzABCDEF";

function idleStatus(): SyncthingFolderStatus {
  return {
    state: "idle",
    localFiles: 1,
    globalFiles: 1,
    needFiles: 0,
    needBytes: 0,
  };
}

function snapshot(
  instance: MeshInstance,
  overrides: Partial<InstanceReconciliationSnapshot> = {},
): InstanceReconciliationSnapshot {
  const peer = instance.id === device.id ? shard : device;
  const peerDevice: SyncthingDevice = {
    deviceID: peer.deviceId,
    name: peer.name,
    addresses: ["dynamic"],
    untrusted: false,
  };
  const folder: SyncthingFolder = {
    id: "vault-id",
    label: "Vault",
    path: instance.folderPath,
    type: instance.kind === "shard" ? "receiveencrypted" : "sendreceive",
    devices: [
      { deviceID: instance.deviceId, encryptionPassword: "" },
      {
        deviceID: peer.deviceId,
        encryptionPassword:
          instance.kind === "device" && peer.kind === "shard" ? key : "",
      },
    ],
  };
  return {
    instance,
    reportedDeviceId: instance.deviceId,
    devices: [peerDevice],
    folders: [folder],
    folderStatus: idleStatus(),
    pendingDeviceIds: [],
    pendingFolderIds: [],
    ...overrides,
  };
}

describe("mesh reconciliation inspection", () => {
  it("accepts a complete device-to-shard mesh", () => {
    expect(
      inspectReconciliationSnapshot(
        snapshot(device),
        [device, shard],
        "vault-id",
        "Vault",
        key,
      ),
    ).toEqual([]);
  });

  it("reports repairable peer, share, label, and invitation drift", () => {
    const current = snapshot(device, {
      devices: [],
      pendingDeviceIds: [shard.deviceId],
      pendingFolderIds: ["vault-id"],
    });
    current.folders[0]!.label = "Old label";
    current.folders[0]!.devices = [
      { deviceID: device.deviceId, encryptionPassword: "" },
    ];
    const issues = inspectReconciliationSnapshot(
      current,
      [device, shard],
      "vault-id",
      "Vault",
      key,
    );
    expect(issues.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        "The managed folder label has drifted.",
        "Peer device “Shard” is missing.",
        "The folder is not shared with “Shard”.",
        "A device invitation from “Shard” is pending.",
        "A managed-folder invitation is pending.",
      ]),
    );
    expect(issues.every((item) => item.repairable)).toBe(true);
  });

  it("blocks identity, path, and folder-type ambiguity", () => {
    const current = snapshot(shard, { reportedDeviceId: "OTHER-ID" });
    expect(
      inspectReconciliationSnapshot(
        current,
        [device, shard],
        "vault-id",
        "Vault",
        key,
      ),
    ).toContainEqual(expect.objectContaining({ repairable: false }));

    const wrongFolder = snapshot(shard);
    wrongFolder.folders[0]!.path = "/other";
    wrongFolder.folders[0]!.type = "sendreceive";
    const issues = inspectReconciliationSnapshot(
      wrongFolder,
      [device, shard],
      "vault-id",
      "Vault",
      key,
    );
    expect(issues.filter((item) => !item.repairable)).toHaveLength(2);
  });

  it("reports unregistered managed-folder shares as repairable", () => {
    const current = snapshot(device);
    current.folders[0]!.devices.push({
      deviceID: "UNKNOWN-ID",
      encryptionPassword: "",
    });
    expect(
      inspectReconciliationSnapshot(
        current,
        [device, shard],
        "vault-id",
        "Vault",
        key,
      ),
    ).toContainEqual(
      expect.objectContaining({
        message: "The managed folder is shared with unregistered device Unknown device · UNKNOWN.",
        repairable: true,
      }),
    );
  });

  it("waits for every configured folder to become idle and complete", () => {
    const current = snapshot(device, {
      folderStatus: { ...idleStatus(), state: "syncing", needFiles: 1 },
    });
    expect(repairBlockedReasons([current])).toEqual([
      "Device must be idle and fully synchronized.",
    ]);
  });

  it("blocks repair while a managed folder is paused", () => {
    const current = snapshot(device);
    current.folders[0]!.paused = true;
    expect(repairBlockedReasons([current])).toEqual([
      "Device's managed folder must be resumed.",
    ]);
  });
});
