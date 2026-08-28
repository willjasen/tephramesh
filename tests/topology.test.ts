import { describe, expect, it } from "vitest";
import type { MeshInstance } from "../src/model";
import {
  activeMeshInstances,
  canRemoveInstance,
  createMeshPlan,
  isSyncthingSyncState,
  meshPeerPolicy,
  meshRuntimeState,
  meshRuntimeStates,
  topologyHealthState,
  unavailableInstanceLabels,
  unavailableStatusIsTolerated,
  unavailableInstancesSummary,
} from "../src/topology";

const endpoint = { protocol: "https" as const, hostname: "example.com", port: 8384 };
const password = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const instances: MeshInstance[] = [
  {
    id: "laptop",
    name: "Laptop",
    kind: "device",
    endpoint,
    deviceId: "LAPTOP-ID",
    folderPath: "/home/me/vault",
  },
  {
    id: "phone",
    name: "Phone",
    kind: "device",
    endpoint,
    deviceId: "PHONE-ID",
    folderPath: "/storage/vault",
  },
  {
    id: "shard",
    name: "Shard",
    kind: "shard",
    endpoint,
    deviceId: "SHARD-ID",
    folderPath: "/srv/encrypted-vault",
  },
];

describe("mesh planner", () => {
  it("creates the complete graph and correct folder modes", () => {
    const plan = createMeshPlan(instances, "vault-id", "My vault", password);
    expect(plan.edgeCount).toBe(3);
    expect(plan.instances).toHaveLength(3);
    expect(plan.instances.find((item) => item.instanceId === "laptop")?.folder.type).toBe(
      "sendreceive",
    );
    expect(plan.instances.find((item) => item.instanceId === "shard")?.folder.type).toBe(
      "receiveencrypted",
    );
  });

  it("only attaches the shard encryption key on trusted-to-shard shares", () => {
    const plan = createMeshPlan(instances, "vault-id", "My vault", password);
    const laptop = plan.instances.find((item) => item.instanceId === "laptop");
    const shard = plan.instances.find((item) => item.instanceId === "shard");
    expect(
      laptop?.folder.devices.find((item) => item.deviceID === "SHARD-ID")
        ?.encryptionPassword,
    ).toBe(password);
    expect(
      laptop?.folder.devices.find((item) => item.deviceID === "PHONE-ID")
        ?.encryptionPassword,
    ).toBe("");
    expect(shard?.folder.devices.every((item) => item.encryptionPassword === "")).toBe(true);
  });

  it("keeps shard device records trusted in both directions", () => {
    const plan = createMeshPlan(instances, "vault-id", "My vault", password);
    const laptop = plan.instances.find((item) => item.instanceId === "laptop");
    const shard = plan.instances.find((item) => item.instanceId === "shard");
    expect(laptop?.devices.find((item) => item.deviceID === "SHARD-ID")?.untrusted).toBe(false);
    expect(shard?.devices.find((item) => item.deviceID === "LAPTOP-ID")?.untrusted).toBe(false);
  });

  it("shares directly between multiple shards without attaching the key", () => {
    const secondShard: MeshInstance = {
      id: "second-shard",
      name: "Second shard",
      kind: "shard",
      endpoint,
      deviceId: "SECOND-SHARD-ID",
      folderPath: "/srv/second-encrypted-vault",
    };
    const firstShard = instances[2]!;
    expect(meshPeerPolicy(firstShard, secondShard, password)).toEqual({
      untrusted: false,
      encryptionPassword: "",
    });
    expect(meshPeerPolicy(secondShard, firstShard, password)).toEqual({
      untrusted: false,
      encryptionPassword: "",
    });

    const plan = createMeshPlan(
      [...instances, secondShard],
      "vault-id",
      "My vault",
      password,
    );
    expect(plan.edgeCount).toBe(6);
    for (const shard of [firstShard, secondShard]) {
      const shardPlan = plan.instances.find((item) => item.instanceId === shard.id);
      const otherId = shard.id === firstShard.id
        ? secondShard.deviceId
        : firstShard.deviceId;
      expect(shardPlan?.folder.devices).toContainEqual({
        deviceID: otherId,
        introducedBy: "",
        encryptionPassword: "",
      });
    }
  });

  it("requires a password as soon as a shard exists", () => {
    expect(() => createMeshPlan(instances, "vault-id", "My vault", "")).toThrow(
      /shard encryption key/i,
    );
  });
});

describe("mesh runtime state", () => {
  const status = (state: string) => ({
    checkedAt: 1,
    ok: true,
    folder: {
      state,
      localFiles: 1,
      globalFiles: 1,
      needFiles: 0,
      needBytes: 0,
    },
  });

  it("prioritizes scanning over syncing and idle", () => {
    expect(meshRuntimeState([status("idle"), status("syncing"), status("scanning")])).toBe("scanning");
  });

  it("shows syncing when any instance is syncing", () => {
    expect(meshRuntimeState([status("idle"), status("syncing")])).toBe("syncing");
  });

  it("treats sync preparation as active syncing", () => {
    expect(isSyncthingSyncState("sync-preparing")).toBe(true);
    expect(meshRuntimeState([status("idle"), status("sync-preparing")])).toBe("syncing");
  });

  it("treats sync waiting as active syncing", () => {
    expect(isSyncthingSyncState("sync-waiting")).toBe(true);
    expect(meshRuntimeState([status("idle"), status("sync-waiting")])).toBe("syncing");
  });

  it("only shows idle when every instance is idle", () => {
    expect(meshRuntimeState([status("idle"), status("idle")])).toBe("idle");
  });

  it("reports unavailable and incomplete samples safely", () => {
    expect(meshRuntimeState([{ checkedAt: 1, ok: false }])).toBe("unavailable");
    expect(meshRuntimeState([undefined])).toBe("checking");
  });
});

describe("active mesh instances", () => {
  it("warns when configured mesh participants are unavailable", () => {
    expect(topologyHealthState(instances, instances)).toBe("healthy");
    expect(topologyHealthState(instances, instances.slice(1))).toBe("warning");
  });

  it("tolerates unavailable status when fewer than all hosts are required", () => {
    expect(unavailableStatusIsTolerated(3, 3)).toBe(false);
    expect(unavailableStatusIsTolerated(2, 3)).toBe(true);
  });

  it("lists unavailable hosts by role and name", () => {
    expect(unavailableInstanceLabels(instances, instances.slice(1))).toEqual(["Device: Laptop"]);
    expect(unavailableInstanceLabels(instances, [])).toEqual([
      "Device: Laptop",
      "Device: Phone",
      "Shard: Shard",
    ]);
  });

  it("summarizes unavailable instances by role", () => {
    expect(unavailableInstancesSummary(instances, instances.slice(1))).toBe("1 device unavailable.");
    expect(unavailableInstancesSummary(instances, [instances[0]!])).toBe("1 device and 1 shard unavailable.");
    expect(unavailableInstancesSummary(instances, [])).toBe("2 devices and 1 shard unavailable.");
  });

  it("excludes pending instances from active safety and reconciliation work", () => {
    const pending: MeshInstance = {
      ...instances[1]!,
      id: "pending-phone",
      deviceId: "PENDING-PHONE-ID",
      setupState: "pending",
    };
    expect(activeMeshInstances([...instances, pending])).toEqual(instances);
  });

  it("shows active work and pending setup as separate states", () => {
    const pending: MeshInstance = {
      ...instances[1]!,
      id: "pending-phone",
      deviceId: "PENDING-PHONE-ID",
      setupState: "pending",
    };
    const statuses = new Map([
      [instances[0]!.id, {
        checkedAt: 1,
        ok: true,
        folder: {
          state: "syncing",
          localFiles: 1,
          globalFiles: 2,
          needFiles: 1,
          needBytes: 1,
        },
      }],
      [instances[1]!.id, {
        checkedAt: 1,
        ok: true,
        folder: {
          state: "idle",
          localFiles: 2,
          globalFiles: 2,
          needFiles: 0,
          needBytes: 0,
        },
      }],
      [instances[2]!.id, {
        checkedAt: 1,
        ok: true,
        folder: {
          state: "idle",
          localFiles: 2,
          globalFiles: 2,
          needFiles: 0,
          needBytes: 0,
        },
      }],
    ]);
    expect(meshRuntimeStates([...instances, pending], statuses)).toEqual([
      "syncing",
      "pending",
    ]);
  });
});

describe("instance removal", () => {
  it("allows either active device to be removed when another active device remains", () => {
    expect(canRemoveInstance(instances, instances[0]!)).toBe(true);
    expect(canRemoveInstance(instances, instances[1]!)).toBe(true);
  });

  it("never allows the last active device to be removed", () => {
    expect(canRemoveInstance([instances[0]!, instances[2]!], instances[0]!)).toBe(false);
  });

  it("does not count a pending device as the remaining active device", () => {
    const pending = { ...instances[1]!, setupState: "pending" as const };
    expect(canRemoveInstance([instances[0]!, pending], instances[0]!)).toBe(false);
    expect(canRemoveInstance([instances[0]!, pending], pending)).toBe(true);
  });

  it("allows shards to be removed without changing the device invariant", () => {
    expect(canRemoveInstance([instances[0]!, instances[2]!], instances[2]!)).toBe(true);
  });
});
