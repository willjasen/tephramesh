import { describe, expect, it } from "vitest";
import type { InstanceRuntimeStatus, MeshInstance } from "../src/model";
import { createConfigSigningGraph, createMeshGraph, createSigningGraph } from "../src/mesh-graph";

const endpoint = { protocol: "https" as const, hostname: "example.com", port: 8384 };
const instances: MeshInstance[] = [
  { id: "mac", name: "MacBook", kind: "device", endpoint, deviceId: "MAC", folderPath: "/vault" },
  { id: "phone", name: "Phone", kind: "device", endpoint, deviceId: "PHONE", folderPath: "/vault" },
  { id: "shard", name: "Shard", kind: "shard", endpoint, deviceId: "SHARD", folderPath: "/vault" },
];

const status = (peerConnections?: Record<string, boolean>): InstanceRuntimeStatus => ({
  checkedAt: 1_000,
  ok: true,
  peerConnections,
});

describe("mesh graph", () => {
  it("lays out active instances and creates every complete-mesh link", () => {
    const graph = createMeshGraph(instances, new Map(), 5, 1_000);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.links).toHaveLength(3);
    expect(graph.nodes.every((node) => node.x >= 0 && node.x <= 100 && node.y >= 0 && node.y <= 100)).toBe(true);
  });

  it("uses fresh Device connection reports to classify links", () => {
    const graph = createMeshGraph(instances, new Map([
      ["mac", status({ PHONE: true, SHARD: false })],
      ["phone", status({ MAC: true })],
    ]), 5, 1_000);
    expect(graph.links.map((link) => [link.source.instance.id, link.target.instance.id, link.state])).toEqual([
      ["mac", "phone", "connected"],
      ["mac", "shard", "disconnected"],
      ["phone", "shard", "unknown"],
    ]);
  });

  it("excludes pending setup instances", () => {
    const graph = createMeshGraph([...instances, { ...instances[0]!, id: "pending", setupState: "pending" }], new Map(), 5, 1_000);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.links).toHaveLength(3);
  });

  it("creates a signing graph with root, approvals, and pending requests", () => {
    const graph = createSigningGraph({
      state: "enrolled",
      rootKeyId: "root",
      revision: 2,
      acceptedCount: 2,
      acceptanceSeenByCount: 2,
      enrolledCount: 3,
      localInstallationName: "MacBook",
      pendingInstallation: {
        bindingId: "mesh:tablet",
        deviceId: "TABLET",
        keyId: "pending-key",
        name: "Tablet",
        source: "mesh",
      },
      authenticatedInstallations: [
        {
          bindingId: "mesh:mac",
          deviceId: "MAC",
          keyId: "root",
          name: "MacBook",
          source: "mesh",
          isLocal: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          isEnrollmentRoot: true,
          acceptedCurrentConfig: true,
          hasSeenLocalAcceptance: true,
        },
        {
          bindingId: "mesh:phone",
          deviceId: "PHONE",
          keyId: "phone-key",
          name: "Phone",
          source: "mesh",
          isLocal: false,
          createdAt: "2024-01-02T00:00:00.000Z",
          approvedByName: "MacBook",
          isEnrollmentRoot: false,
          acceptedCurrentConfig: true,
          hasSeenLocalAcceptance: true,
        },
      ],
    });

    expect(graph.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(["MacBook", "Phone", "Tablet"]));
    expect(graph.links.some((link) => link.state === "rooted" && link.source.name === "MacBook" && link.target.name === "Phone")).toBe(true);
    expect(graph.links.some((link) => link.state === "pending" && link.source.name === "MacBook" && link.target.name === "Tablet")).toBe(true);
    expect(graph.nodes.find((node) => node.name === "Phone")?.signingStatus).toMatchObject({
      usingCurrentConfig: true,
      knowsLocalUpdate: true,
      pending: false,
    });
    expect(graph.nodes.find((node) => node.name === "Tablet")?.signingStatus).toMatchObject({
      usingCurrentConfig: false,
      knowsLocalUpdate: false,
      pending: true,
    });
  });

  it("creates a full-mesh config-signing graph with pairwise acceptance and acknowledgement state", () => {
    const graph = createSigningGraph({
      state: "enrolled",
      rootKeyId: "root",
      revision: 2,
      acceptedCount: 2,
      acceptanceSeenByCount: 1,
      enrolledCount: 3,
      localInstallationName: "MacBook",
      pendingInstallation: {
        bindingId: "mesh:tablet",
        deviceId: "TABLET",
        keyId: "pending-key",
        name: "Tablet",
        source: "mesh",
      },
      authenticatedInstallations: [
        {
          bindingId: "mesh:mac",
          deviceId: "MAC",
          keyId: "root",
          name: "MacBook",
          source: "mesh",
          isLocal: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          isEnrollmentRoot: true,
          acceptedCurrentConfig: true,
          hasSeenLocalAcceptance: true,
        },
        {
          bindingId: "mesh:phone",
          deviceId: "PHONE",
          keyId: "phone-key",
          name: "Phone",
          source: "mesh",
          isLocal: false,
          createdAt: "2024-01-02T00:00:00.000Z",
          approvedByName: "MacBook",
          isEnrollmentRoot: false,
          acceptedCurrentConfig: true,
          hasSeenLocalAcceptance: false,
        },
      ],
    });

    const configGraph = createConfigSigningGraph({
      state: "enrolled",
      rootKeyId: "root",
      revision: 2,
      acceptedCount: 2,
      acceptanceSeenByCount: 1,
      enrolledCount: 3,
      localInstallationName: "MacBook",
      pendingInstallation: {
        bindingId: "mesh:tablet",
        deviceId: "TABLET",
        keyId: "pending-key",
        name: "Tablet",
        source: "mesh",
      },
      authenticatedInstallations: [
        {
          bindingId: "mesh:mac",
          deviceId: "MAC",
          keyId: "root",
          name: "MacBook",
          source: "mesh",
          isLocal: true,
          createdAt: "2024-01-01T00:00:00.000Z",
          isEnrollmentRoot: true,
          acceptedCurrentConfig: true,
          hasSeenLocalAcceptance: true,
        },
        {
          bindingId: "mesh:phone",
          deviceId: "PHONE",
          keyId: "phone-key",
          name: "Phone",
          source: "mesh",
          isLocal: false,
          createdAt: "2024-01-02T00:00:00.000Z",
          approvedByName: "MacBook",
          isEnrollmentRoot: false,
          acceptedCurrentConfig: true,
          hasSeenLocalAcceptance: false,
        },
      ],
    });

    expect(configGraph.nodes).toHaveLength(3);
    expect(configGraph.links).toHaveLength(3);
    expect(configGraph.links.some((link) => link.state === "rooted" && link.source.name === "MacBook" && link.target.name === "Phone")).toBe(true);
    expect(configGraph.links.some((link) => link.state === "pending" && link.source.name === "Phone" && link.target.name === "Tablet")).toBe(true);
  });
});
