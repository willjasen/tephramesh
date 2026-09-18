import type { InstanceRuntimeStatus, MeshInstance } from "./model";
import { isRuntimeStatusFresh } from "./topology";

export type MeshGraphLinkState = "connected" | "disconnected" | "unknown" | "rooted" | "approved" | "pending";

export interface MeshGraphSigningStatus {
  usingCurrentConfig: boolean;
  knowsLocalUpdate: boolean;
  pending: boolean;
}

export interface MeshGraphNode {
  name: string;
  instance: MeshInstance;
  x: number;
  y: number;
  signingStatus?: MeshGraphSigningStatus;
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

export interface SigningEnvironmentGraphStatus {
  state: "unsigned" | "approval-required" | "enrolled";
  rootKeyId: string;
  revision?: number;
  acceptedCount?: number;
  acceptanceSeenByCount?: number;
  enrolledCount?: number;
  localInstallationName?: string;
  pendingInstallation?: {
    bindingId: string;
    deviceId: string;
    keyId: string;
    name: string;
    source: "mesh" | "known" | "unconfigured";
  };
  authenticatedInstallations: Array<{
    bindingId: string;
    deviceId: string;
    keyId: string;
    name: string;
    source: "mesh" | "known" | "unconfigured";
    isLocal: boolean;
    createdAt: string;
    approvedByName?: string;
    isEnrollmentRoot: boolean;
    acceptedCurrentConfig: boolean;
    hasSeenLocalAcceptance: boolean;
  }>;
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
      name: instance.name,
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

export function createSigningGraph(status: SigningEnvironmentGraphStatus): MeshGraph {
  const nodeEntries: Array<{
    id: string;
    name: string;
    kind: MeshInstance["kind"];
    deviceId: string;
    setupState?: MeshInstance["setupState"];
    isRoot: boolean;
    approvedByName?: string;
    isPending: boolean;
    usingCurrentConfig: boolean;
    knowsLocalUpdate: boolean;
  }> = [];

  for (const installation of status.authenticatedInstallations) {
    nodeEntries.push({
      id: installation.keyId,
      name: installation.name,
      kind: "device",
      deviceId: installation.deviceId,
      isRoot: installation.isEnrollmentRoot,
      approvedByName: installation.approvedByName,
      isPending: false,
      usingCurrentConfig: installation.acceptedCurrentConfig,
      knowsLocalUpdate: installation.hasSeenLocalAcceptance,
    });
  }

  if (status.pendingInstallation) {
    nodeEntries.push({
      id: status.pendingInstallation.keyId,
      name: status.pendingInstallation.name,
      kind: "device",
      deviceId: status.pendingInstallation.deviceId,
      isRoot: false,
      isPending: true,
      usingCurrentConfig: false,
      knowsLocalUpdate: false,
    });
  }

  const uniqueNodes = new Map<string, typeof nodeEntries[number]>();
  for (const entry of nodeEntries) {
    if (!uniqueNodes.has(entry.id)) uniqueNodes.set(entry.id, entry);
  }
  const nodes = [...uniqueNodes.values()].map((node, index) => {
    const angle = uniqueNodes.size === 1
      ? -Math.PI / 2
      : -Math.PI / 2 + (index * Math.PI * 2) / uniqueNodes.size;
    const instance: MeshInstance = {
      id: node.id,
      name: node.name,
      kind: node.kind,
      endpoint: { protocol: "https", hostname: "signing", port: 443 },
      deviceId: node.deviceId,
      folderPath: "/signing",
      setupState: node.isPending ? "pending" : undefined,
    };
    return {
      name: node.name,
      instance,
      x: 50 + Math.cos(angle) * 36,
      y: 50 + Math.sin(angle) * 36,
      signingStatus: {
        usingCurrentConfig: node.usingCurrentConfig,
        knowsLocalUpdate: node.knowsLocalUpdate,
        pending: node.isPending,
      },
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.instance.id, node]));
  const nodeByName = new Map(nodes.map((node) => [node.instance.name, node]));
  const links: MeshGraphLink[] = [];

  const rootNode = status.rootKeyId ? nodeById.get(status.rootKeyId) : undefined;
  for (const node of nodes) {
    const entry = [...uniqueNodes.values()].find((candidate) => candidate.id === node.instance.id);
    if (!entry) continue;
    if (entry.isPending) {
      if (rootNode) {
        links.push({ source: rootNode, target: node, state: "pending" });
      }
      continue;
    }
    if (rootNode && node.instance.id !== status.rootKeyId) {
      const source = entry.approvedByName ? nodeByName.get(entry.approvedByName) ?? rootNode : rootNode;
      if (source && source.instance.id !== node.instance.id) {
        links.push({
          source: source,
          target: node,
          state: source.instance.id === rootNode.instance.id ? "rooted" : "approved",
        });
      }
    }
  }

  return { nodes, links };
}

export function createConfigSigningGraph(status: SigningEnvironmentGraphStatus): MeshGraph {
  const nodeEntries: Array<{
    id: string;
    name: string;
    kind: MeshInstance["kind"];
    deviceId: string;
    setupState?: MeshInstance["setupState"];
    isPending: boolean;
    usingCurrentConfig: boolean;
    knowsLocalUpdate: boolean;
  }> = [];

  for (const installation of status.authenticatedInstallations) {
    nodeEntries.push({
      id: installation.keyId,
      name: installation.name,
      kind: "device",
      deviceId: installation.deviceId,
      isPending: false,
      usingCurrentConfig: installation.acceptedCurrentConfig,
      knowsLocalUpdate: installation.hasSeenLocalAcceptance,
    });
  }

  if (status.pendingInstallation) {
    nodeEntries.push({
      id: status.pendingInstallation.keyId,
      name: status.pendingInstallation.name,
      kind: "device",
      deviceId: status.pendingInstallation.deviceId,
      isPending: true,
      usingCurrentConfig: false,
      knowsLocalUpdate: false,
    });
  }

  const uniqueNodes = new Map<string, typeof nodeEntries[number]>();
  for (const entry of nodeEntries) {
    if (!uniqueNodes.has(entry.id)) uniqueNodes.set(entry.id, entry);
  }

  const nodes = [...uniqueNodes.values()].map((node, index) => {
    const angle = uniqueNodes.size === 1
      ? -Math.PI / 2
      : -Math.PI / 2 + (index * Math.PI * 2) / uniqueNodes.size;
    const instance: MeshInstance = {
      id: node.id,
      name: node.name,
      kind: node.kind,
      endpoint: { protocol: "https", hostname: "signing", port: 443 },
      deviceId: node.deviceId,
      folderPath: "/signing",
      setupState: node.isPending ? "pending" : undefined,
    };
    return {
      name: node.name,
      instance,
      x: 50 + Math.cos(angle) * 36,
      y: 50 + Math.sin(angle) * 36,
      signingStatus: {
        usingCurrentConfig: node.usingCurrentConfig,
        knowsLocalUpdate: node.knowsLocalUpdate,
        pending: node.isPending,
      },
    };
  });

  const links: MeshGraphLink[] = [];
  for (let sourceIndex = 0; sourceIndex < nodes.length; sourceIndex += 1) {
    for (let targetIndex = sourceIndex + 1; targetIndex < nodes.length; targetIndex += 1) {
      const source = nodes[sourceIndex]!;
      const target = nodes[targetIndex]!;
      const sourceEntry = uniqueNodes.get(source.instance.id);
      const targetEntry = uniqueNodes.get(target.instance.id);
      if (!sourceEntry || !targetEntry) continue;

      let state: MeshGraphLinkState = "pending";
      if (sourceEntry.usingCurrentConfig && targetEntry.usingCurrentConfig) {
        state = "rooted";
      } else if (sourceEntry.knowsLocalUpdate || targetEntry.knowsLocalUpdate) {
        state = "approved";
      }

      links.push({ source, target, state });
    }
  }

  return { nodes, links };
}
