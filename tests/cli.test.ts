import { describe, expect, it } from "vitest";
import { buildCliState, buildCliTestResult } from "../src/cli";
import { DEFAULT_SETTINGS, type InstanceRuntimeStatus, type MeshInstance } from "../src/model";
import { INTERNAL_SECRET_ACCESS, requireInternalSecretAccess } from "../src/internal-access";

const instance: MeshInstance = {
  id: "laptop",
  name: "Laptop",
  kind: "device",
  endpoint: { protocol: "http", hostname: "127.0.0.1", port: 8384 },
  deviceId: "DEVICE-ID",
  folderPath: "/vault",
};

describe("Obsidian CLI state", () => {
  it("returns a secret-free summary of the cached plugin state", () => {
    const runtime: InstanceRuntimeStatus = {
      checkedAt: 1_000,
      ok: true,
      version: "v2.0.0",
      folder: { state: "idle", localFiles: 4, globalFiles: 4, needFiles: 0, needBytes: 0 },
    };
    const result = buildCliState({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        onboardingComplete: true,
        folderId: "tephramesh-test",
        instances: [instance],
      },
      runtimeStatuses: new Map([[instance.id, runtime]]),
      configured: true,
      unlocked: true,
      signing: {
        state: "enrolled",
        revision: 3,
        acceptedCount: 1,
        acceptanceSeenByCount: 1,
        enrolledCount: 1,
      },
      reconciliation: { state: "healthy", issues: [], repairBlockedReasons: [] },
      now: 1_000,
    });

    expect(result.mesh.state).toBe("ready");
    expect(result.instances[0]).toMatchObject({ name: "Laptop", status: "idle" });
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    expect(JSON.stringify(result)).not.toContain("DEVICE-ID");
    expect(JSON.stringify(result)).not.toContain("syncthing-api-key");
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("marks stale runtime data unavailable", () => {
    const result = buildCliState({
      settings: { ...structuredClone(DEFAULT_SETTINGS), instances: [instance] },
      runtimeStatuses: new Map([[instance.id, { checkedAt: 1_000, ok: true }]]),
      configured: true,
      unlocked: true,
      signing: {
        state: "unsigned",
        revision: 0,
        acceptedCount: 0,
        acceptanceSeenByCount: 0,
        enrolledCount: 0,
      },
      reconciliation: { state: "checking", issues: [], repairBlockedReasons: [] },
      now: 10_000,
    });
    expect(result.instances[0]?.status).toBe("unavailable");
  });
});

describe("Obsidian CLI tests", () => {
  it("fails only when at least one check fails", () => {
    expect(buildCliTestResult([{ id: "one", status: "warn", summary: "Pending" }], 0).passed).toBe(true);
    expect(buildCliTestResult([{ id: "one", status: "fail", summary: "Broken" }], 0).passed).toBe(false);
  });
});

describe("secret access guard", () => {
  it("accepts only the module-scoped internal capability", () => {
    expect(() => requireInternalSecretAccess(Symbol("lookalike"))).toThrow(
      "Protected Tephramesh data is unavailable through automation APIs.",
    );
    expect(() => requireInternalSecretAccess(INTERNAL_SECRET_ACCESS)).not.toThrow();
  });
});
