import type { InstanceRuntimeStatus, MeshInstance, TephrameshSettings } from "./model";
import type { ReconciliationReport } from "./reconciliation";
import { activeMeshInstances, isRuntimeStatusFresh, meshStatusBarPresentation } from "./topology";

export const TEPHRAMESH_CLI_API_VERSION = 1;

export type CliCheckStatus = "pass" | "warn" | "fail";

export interface CliCheck {
  id: string;
  status: CliCheckStatus;
  summary: string;
  instance?: string;
  detail?: string;
}

export interface CliSigningState {
  state: "unsigned" | "approval-required" | "enrolled";
  revision: number;
  acceptedCount: number;
  acceptanceSeenByCount: number;
  enrolledCount: number;
  localInstallationName?: string;
}

export interface TephrameshCliState {
  apiVersion: number;
  generatedAt: string;
  configured: boolean;
  unlocked: boolean;
  onboardingComplete: boolean;
  mesh: {
    state: ReturnType<typeof meshStatusBarPresentation>["state"];
    summary: string;
    instanceCount: number;
    activeInstanceCount: number;
    knownDeviceCount: number;
  };
  signing: CliSigningState;
  reconciliation: {
    state: ReconciliationReport["state"];
    issueCount: number;
    repairBlockedReasonCount: number;
  };
  instances: Array<{
    name: string;
    kind: MeshInstance["kind"];
    setup: "active" | "pending";
    status: "unchecked" | "unavailable" | "idle" | "scanning" | "syncing" | "other";
    checkedAt?: string;
    folderState?: string;
    pendingFiles?: number;
    pendingBytes?: number;
    errors?: number;
    version?: string;
    operatingSystem?: string;
    error?: string;
  }>;
}

export interface TephrameshCliTestResult {
  apiVersion: number;
  generatedAt: string;
  passed: boolean;
  totals: Record<CliCheckStatus, number>;
  checks: CliCheck[];
}

function runtimeLabel(
  status: InstanceRuntimeStatus | undefined,
  timeoutSeconds: number,
  now: number,
): TephrameshCliState["instances"][number]["status"] {
  if (!status) return "unchecked";
  if (!isRuntimeStatusFresh(status, timeoutSeconds, now)) return "unavailable";
  const state = status.folder?.state;
  if (state === "idle" || state === "scanning" || state === "syncing") return state;
  if (state === "sync-preparing" || state === "sync-waiting") return "syncing";
  return "other";
}

export function buildCliState(input: {
  settings: TephrameshSettings;
  runtimeStatuses: ReadonlyMap<string, InstanceRuntimeStatus>;
  configured: boolean;
  unlocked: boolean;
  signing: CliSigningState;
  reconciliation: ReconciliationReport;
  now?: number;
}): TephrameshCliState {
  const now = input.now ?? Date.now();
  const active = activeMeshInstances(input.settings.instances);
  const presentation = meshStatusBarPresentation(
    input.settings.instances,
    input.runtimeStatuses,
    input.settings.offlineTimeoutSeconds,
    now,
  );
  return {
    apiVersion: TEPHRAMESH_CLI_API_VERSION,
    generatedAt: new Date(now).toISOString(),
    configured: input.configured,
    unlocked: input.unlocked,
    onboardingComplete: input.settings.onboardingComplete,
    mesh: {
      state: presentation.state,
      summary: presentation.label,
      instanceCount: input.settings.instances.length,
      activeInstanceCount: active.length,
      knownDeviceCount: input.settings.knownDevices.length,
    },
    signing: { ...input.signing },
    reconciliation: {
      state: input.reconciliation.state,
      issueCount: input.reconciliation.issues.length,
      repairBlockedReasonCount: input.reconciliation.repairBlockedReasons.length,
    },
    instances: input.settings.instances.map((instance) => {
      const runtime = input.runtimeStatuses.get(instance.id);
      const errors = (runtime?.folder?.errors ?? 0) + (runtime?.folder?.pullErrors ?? 0);
      return {
        name: instance.name,
        kind: instance.kind,
        setup: instance.setupState === "pending" ? "pending" : "active",
        status: runtimeLabel(runtime, input.settings.offlineTimeoutSeconds, now),
        checkedAt: runtime ? new Date(runtime.checkedAt).toISOString() : undefined,
        folderState: runtime?.folder?.state,
        pendingFiles: runtime?.folder?.needFiles,
        pendingBytes: runtime?.folder?.needBytes,
        errors: runtime?.folder ? errors : undefined,
        version: runtime?.version,
        operatingSystem: runtime?.operatingSystem,
        error: runtime?.error,
      };
    }),
  };
}

export function buildCliTestResult(checks: CliCheck[], now = Date.now()): TephrameshCliTestResult {
  const totals: Record<CliCheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) totals[check.status] += 1;
  return {
    apiVersion: TEPHRAMESH_CLI_API_VERSION,
    generatedAt: new Date(now).toISOString(),
    passed: totals.fail === 0,
    totals,
    checks,
  };
}
