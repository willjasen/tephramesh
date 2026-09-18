import type { InstanceRuntimeStatus, MeshInstance } from "./model";
import { isRuntimeStatusFresh } from "./topology";

export type MeshGraphLinkState = "connected" | "disconnected" | "unknown";

export interface MeshGraphNode {
  instance: MeshInstance;
  x: number;
  y: number;
}

export interface MeshGraphLink {
  source: MeshGraphNode;
  target: MeshGraphNode;
  state: MeshGraphLinkState;
}

export interface MeshGraph {
  nodes: MeshGraphNode[];
  links: MeshGraphLink[];
}

export function createMeshGraph(
  instances: MeshInstance[],
  statuses: ReadonlyMap<string, InstanceRuntimeStatus>,
  timeoutSeconds: number,
  now = Date.now(),
): MeshGraph {
  const active = instances.filter((instance) => instance.setupState !== "pending");
  const nodes = active.map((instance, index) => {
    const angle = active.length === 1
      ? -Math.PI / 2
      : -Math.PI / 2 + (index * Math.PI * 2) / active.length;
    return {
      instance,
      x: 50 + Math.cos(angle) * 36,
      y: 50 + Math.sin(angle) * 36,
    };
  });
  const links: MeshGraphLink[] = [];
  for (let sourceIndex = 0; sourceIndex < nodes.length; sourceIndex += 1) {
    for (let targetIndex = sourceIndex + 1; targetIndex < nodes.length; targetIndex += 1) {
      const source = nodes[sourceIndex]!;
      const target = nodes[targetIndex]!;
      links.push({
        source,
        target,
        state: linkState(source.instance, target.instance, statuses, timeoutSeconds, now),
      });
    }
  }
  return { nodes, links };
}

function linkState(
  source: MeshInstance,
  target: MeshInstance,
  statuses: ReadonlyMap<string, InstanceRuntimeStatus>,
  timeoutSeconds: number,
  now: number,
): MeshGraphLinkState {
  const reports = [
    peerReport(source, target, statuses, timeoutSeconds, now),
    peerReport(target, source, statuses, timeoutSeconds, now),
  ].filter((report): report is boolean => report !== undefined);
  if (reports.includes(true)) return "connected";
  if (reports.includes(false)) return "disconnected";
  return "unknown";
}

function peerReport(
  reporter: MeshInstance,
  peer: MeshInstance,
  statuses: ReadonlyMap<string, InstanceRuntimeStatus>,
  timeoutSeconds: number,
  now: number,
): boolean | undefined {
  if (reporter.kind !== "device") return undefined;
  const status = statuses.get(reporter.id);
  if (!isRuntimeStatusFresh(status, timeoutSeconds, now)) return undefined;
  return status?.peerConnections?.[peer.deviceId];
}
