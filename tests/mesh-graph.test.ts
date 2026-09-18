import { describe, expect, it } from "vitest";
import type { InstanceRuntimeStatus, MeshInstance } from "../src/model";
import { createMeshGraph } from "../src/mesh-graph";

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
});
