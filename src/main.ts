import { normalizePath, Plugin, setIcon } from "obsidian";
import { DEFAULT_SETTINGS, type InstanceRuntimeStatus, type MeshInstance, type TephrameshSettings, type KnownDevice } from "./model";
import { TephrameshSettingTab } from "./settings-tab";
import { SyncthingApiError, SyncthingClient } from "./syncthing-client";
import { showTephrameshNotice } from "./notices";
import { localSyncthingDeviceName } from "./syncthing-device";
import { MeshNotReadyError } from "./mesh-errors";
import { generateShardPassword, sha256Hex } from "./security";
import { trafficRates } from "./syncthing-traffic";
import {
  activeMeshInstances,
  canRemoveInstance,
  createMeshPlan,
  meshPeerPolicy,
} from "./topology";
import { pendingFolderPaths } from "./note-sync";
import {
  inspectReconciliationSnapshot,
  repairBlockedReasons,
  type InstanceReconciliationSnapshot,
  type ReconciliationIssue,
  type ReconciliationReport,
} from "./reconciliation";
import {
  AGE_IDENTITY_SECRET_NAME,
  decryptProtectedData,
  decryptSecrets,
  emptySecrets,
  encryptProtectedData,
  type TephrameshSecrets,
  validateAgeKeyPair,
} from "./secret-bundle";

interface EncryptedSettingsEnvelope {
  schemaVersion: 3;
  ageRecipient: string;
  encryptedData: string;
}

interface LegacyEncryptedSettings extends Partial<TephrameshSettings> {
  encryptedSecrets?: string;
}

interface LegacyInstanceSecrets {
  apiKeySecretName?: string;
}

interface LegacyRootSecrets {
  shardPasswordSecretName?: string;
}

export default class TephrameshPlugin extends Plugin {
  settings: TephrameshSettings = structuredClone(DEFAULT_SETTINGS);
  runtimeStatuses = new Map<string, InstanceRuntimeStatus>();
  reconciliationReport: ReconciliationReport = {
    state: "checking",
    issues: [],
    repairBlockedReasons: [],
  };
  private secrets?: TephrameshSecrets;
  private encryptedData = "";
  private storageFormat: 2 | 3 = 3;
  private settingTab!: TephrameshSettingTab;
  private pollingTimer?: number;
  private statusPollingEnabled = false;
  private noteSyncTimer?: number;
  private noteSyncRefreshInProgress = false;
  private pendingNotePaths = new Set<string>();
  private fileExplorerObserver?: MutationObserver;
  private refreshInProgress = false;
  private nextNameRefreshAt = 0;
  private nextReconciliationAt = 0;
  private reconciliationInProgress = false;
  private folderLabelSyncTimer?: number;
  private folderLabelSyncQueue: Promise<void> = Promise.resolve();
  private static readonly NAME_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly LABEL_SYNC_DEBOUNCE_MS = 750;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.tryUnlockStoredIdentity();
    this.settingTab = new TephrameshSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.addCommand({
      id: "refresh-syncthing-status",
      name: "Refresh Syncthing status",
      callback: async () => {
        await this.refreshStatuses(true);
        showTephrameshNotice("success", "Status refreshed");
      },
    });
    this.restartNoteSyncPolling();
    void this.refreshReconciliation();
  }

  onunload(): void {
    this.secrets = undefined;
    if (this.pollingTimer !== undefined) window.clearInterval(this.pollingTimer);
    if (this.noteSyncTimer !== undefined) window.clearInterval(this.noteSyncTimer);
    this.fileExplorerObserver?.disconnect();
    this.clearNoteSyncBadges();
    if (this.folderLabelSyncTimer !== undefined) {
      window.clearTimeout(this.folderLabelSyncTimer);
    }
  }

  async onExternalSettingsChange(): Promise<void> {
    this.secrets = undefined;
    await this.loadSettings();
    await this.tryUnlockStoredIdentity();
    this.restartNoteSyncPolling();
    this.settingTab.rerenderIfVisible();
    if (this.statusPollingEnabled) void this.refreshStatuses(true);
    void this.refreshReconciliation(true);
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as
      | EncryptedSettingsEnvelope
      | LegacyEncryptedSettings
      | null;
    if (
      stored?.schemaVersion === 3 &&
      "encryptedData" in stored &&
      typeof stored.encryptedData === "string"
    ) {
      this.settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        ageRecipient: stored.ageRecipient ?? "",
      };
      this.encryptedData = stored.encryptedData;
      this.storageFormat = 3;
      return;
    }
    const legacy = stored as LegacyEncryptedSettings | null;
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...legacy,
      instances: Array.isArray(legacy?.instances) ? legacy.instances : [],
      schemaVersion: 3,
    };
    this.encryptedData =
      legacy && "encryptedSecrets" in legacy
        ? legacy.encryptedSecrets ?? ""
        : "";
    this.storageFormat = 2;
  }

  async saveSettings(): Promise<void> {
    if (!this.secrets || !this.settings.ageRecipient) {
      throw new Error("Unlock Tephramesh encryption before saving settings.");
    }
    const { ageRecipient, ...protectedSettings } = this.settings;
    this.encryptedData = await encryptProtectedData(ageRecipient, {
      schemaVersion: 1,
      settings: protectedSettings,
      secrets: this.secrets,
    });
    this.storageFormat = 3;
    await this.saveData({
      schemaVersion: 3,
      ageRecipient,
      encryptedData: this.encryptedData,
    } satisfies EncryptedSettingsEnvelope);
  }

  async deleteConfig(): Promise<void> {
    const pluginDirectory =
      this.manifest.dir ??
      `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const dataPath = normalizePath(`${pluginDirectory}/data.json`);
    if (await this.app.vault.adapter.exists(dataPath)) {
      await this.app.vault.adapter.remove(dataPath);
    }

    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.secrets = undefined;
    this.encryptedData = "";
    this.storageFormat = 3;
    this.runtimeStatuses.clear();
    this.reconciliationReport = {
      state: "checking",
      issues: [],
      repairBlockedReasons: [],
    };
    this.pendingNotePaths.clear();
    this.clearNoteSyncBadges();
    if (this.folderLabelSyncTimer !== undefined) {
      window.clearTimeout(this.folderLabelSyncTimer);
      this.folderLabelSyncTimer = undefined;
    }
    this.restartPolling();
    this.restartNoteSyncPolling();
  }

  hasEncryptionConfigured(): boolean {
    return Boolean(this.settings.ageRecipient && this.encryptedData);
  }

  secretsAreUnlocked(): boolean {
    return this.secrets !== undefined;
  }

  getApiKey(instanceId: string): string | null {
    return this.secrets?.apiKeys[instanceId] ?? null;
  }

  getShardEncryptionKey(): string | null {
    return this.secrets?.shardEncryptionKey || null;
  }

  getDecryptedConfig(): { settings: TephrameshSettings; secrets: TephrameshSecrets } | null {
    if (!this.secrets) return null;
    return {
      settings: structuredClone(this.settings),
      secrets: structuredClone(this.secrets),
    };
  }

  async configureEncryption(recipient: string, identity: string): Promise<void> {
    const keys = await validateAgeKeyPair(recipient, identity);
    const migrated = emptySecrets();
    for (const instance of this.settings.instances) {
      const legacyName = (instance as MeshInstance & LegacyInstanceSecrets)
        .apiKeySecretName;
      const apiKey = legacyName
        ? this.app.secretStorage.getSecret(legacyName)
        : undefined;
      if (this.settings.onboardingComplete && !apiKey) {
        throw new Error(
          `The existing API key for ${instance.name} is unavailable. Restore it in Obsidian Keychain before migrating.`,
        );
      }
      if (apiKey) migrated.apiKeys[instance.id] = apiKey;
    }
    const legacyShardName = (this.settings as TephrameshSettings & LegacyRootSecrets)
      .shardPasswordSecretName;
    const legacyShardKey = legacyShardName
      ? this.app.secretStorage.getSecret(legacyShardName)
      : undefined;
    if (this.settings.shardEncryptionKeyHash && !legacyShardKey) {
      throw new Error(
        "The existing shard encryption key is unavailable. Restore it in Obsidian Keychain before migrating.",
      );
    }
    migrated.shardEncryptionKey = legacyShardKey ?? "";
    if (!migrated.shardEncryptionKey) {
      migrated.shardEncryptionKey = generateShardPassword();
      this.settings.shardEncryptionKeyHash = await sha256Hex(
        migrated.shardEncryptionKey,
      );
    }

    this.settings.instances = this.settings.instances.map((instance) => {
      const cleaned = { ...instance } as MeshInstance & LegacyInstanceSecrets;
      delete cleaned.apiKeySecretName;
      return cleaned;
    });
    delete (this.settings as TephrameshSettings & LegacyRootSecrets)
      .shardPasswordSecretName;
    this.settings.ageRecipient = keys.recipient;
    this.secrets = migrated;
    this.app.secretStorage.setSecret(AGE_IDENTITY_SECRET_NAME, keys.identity);
    await this.saveSettings();
  }

  async unlockSecrets(identity: string): Promise<void> {
    const keys = await validateAgeKeyPair(this.settings.ageRecipient, identity);
    await this.decryptStoredData(keys.identity);
    this.app.secretStorage.setSecret(AGE_IDENTITY_SECRET_NAME, keys.identity);
    if (this.statusPollingEnabled) void this.refreshStatuses(true);
  }

  async setApiKey(instanceId: string, apiKey: string): Promise<void> {
    if (!this.secrets) throw new Error("Unlock Tephramesh secrets first.");
    this.secrets.apiKeys[instanceId] = apiKey;
    await this.persistSecrets();
  }

  async removeApiKey(instanceId: string): Promise<void> {
    if (!this.secrets) throw new Error("Unlock Tephramesh secrets first.");
    delete this.secrets.apiKeys[instanceId];
    await this.persistSecrets();
  }

  async savePendingInstance(instance: MeshInstance, apiKey: string): Promise<void> {
    if (!this.secrets) throw new Error("Unlock Tephramesh secrets first.");
    instance.setupState = "pending";
    this.settings.instances.push(instance);
    this.secrets.apiKeys[instance.id] = apiKey;
    try {
      await this.saveSettings();
    } catch (error) {
      this.settings.instances = this.settings.instances.filter(
        (candidate) => candidate.id !== instance.id,
      );
      delete this.secrets.apiKeys[instance.id];
      throw error;
    }
  }

  private async persistSecrets(): Promise<void> {
    if (!this.secrets || !this.settings.ageRecipient) {
      throw new Error("Tephramesh encryption is not configured.");
    }
    await this.saveSettings();
  }

  private async tryUnlockStoredIdentity(): Promise<void> {
    if (!this.hasEncryptionConfigured()) return;
    const identity = this.app.secretStorage.getSecret(AGE_IDENTITY_SECRET_NAME);
    if (!identity) return;
    try {
      const keys = await validateAgeKeyPair(this.settings.ageRecipient, identity);
      await this.decryptStoredData(keys.identity);
    } catch {
      this.secrets = undefined;
    }
  }

  private async decryptStoredData(identity: string): Promise<void> {
    if (this.storageFormat === 3) {
      const recipient = this.settings.ageRecipient;
      const protectedData = await decryptProtectedData(identity, this.encryptedData);
      this.settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        ...protectedData.settings,
        ageRecipient: recipient,
        instances: Array.isArray(protectedData.settings.instances)
          ? protectedData.settings.instances
          : [],
        schemaVersion: 3,
      };
      this.secrets = protectedData.secrets;
      return;
    }
    this.secrets = await decryptSecrets(identity, this.encryptedData);
    await this.saveSettings();
  }

  async assertMeshReadyForInstanceAdd(): Promise<void> {
    const problems: string[] = [];
    const activeInstances = activeMeshInstances(this.settings.instances);
    await Promise.all(
      activeInstances.map(async (instance) => {
        try {
          const apiKey = this.getApiKey(instance.id);
          if (!apiKey) throw new Error("API key unavailable");
          const client = new SyncthingClient(instance.endpoint, apiKey);
          const [status, folder] = await Promise.all([
            client.getFolderStatus(this.settings.folderId),
            client.getFolder(this.settings.folderId),
          ]);
          if (folder.paused) {
            problems.push(`${instance.name}'s managed folder is paused.`);
            return;
          }
          if (status.state !== "idle") {
            problems.push(`${instance.name} is ${status.state}.`);
            return;
          }
          const errors = (status.errors ?? 0) + (status.pullErrors ?? 0);
          if (status.needFiles > 0 || status.needBytes > 0 || errors > 0) {
            problems.push(
              `${instance.name} is idle but not fully synchronized (${status.needFiles} pending file${status.needFiles === 1 ? "" : "s"}${errors ? `, ${errors} error${errors === 1 ? "" : "s"}` : ""}).`,
            );
          }
        } catch (error) {
          problems.push(
            `${instance.name} could not be verified: ${error instanceof Error ? error.message : String(error)}.`,
          );
        }
      }),
    );
    if (problems.length > 0) {
      throw new MeshNotReadyError(
        `${problems.join(" ")} Wait until every existing instance is idle and fully synchronized, then Test and Add again.`,
      );
    }
  }

  async reconcileNewInstance(candidate: MeshInstance): Promise<void> {
    const candidateApiKey = this.getApiKey(candidate.id);
    if (!candidateApiKey) {
      throw new Error(`API key unavailable for ${candidate.name}.`);
    }
    const candidateClient = new SyncthingClient(candidate.endpoint, candidateApiKey);
    const shardKey = this.getShardEncryptionKey() ?? "";

    for (const existing of activeMeshInstances(this.settings.instances)) {
      if (existing.id === candidate.id) continue;
      const existingApiKey = this.getApiKey(existing.id);
      if (!existingApiKey) {
        throw new Error(`API key unavailable for ${existing.name}.`);
      }
      const existingClient = new SyncthingClient(existing.endpoint, existingApiKey);
      const existingPolicy = meshPeerPolicy(existing, candidate, shardKey);
      const candidatePolicy = meshPeerPolicy(candidate, existing, shardKey);

      await existingClient.ensureDevice(
        candidate.deviceId,
        candidate.name,
        existingPolicy.untrusted,
      );
      await candidateClient.ensureDevice(
        existing.deviceId,
        existing.name,
        candidatePolicy.untrusted,
      );
      await existingClient.ensureFolderPeer(
        this.settings.folderId,
        candidate.deviceId,
        existingPolicy.encryptionPassword,
      );
      await candidateClient.ensureFolderPeer(
        this.settings.folderId,
        existing.deviceId,
        candidatePolicy.encryptionPassword,
      );
    }
  }

  private async inspectInstanceForReconciliation(
    instance: MeshInstance,
  ): Promise<InstanceReconciliationSnapshot> {
    const apiKey = this.getApiKey(instance.id);
    if (!apiKey) throw new Error("API key unavailable");
    const client = new SyncthingClient(instance.endpoint, apiKey);
    const [system, devices, folders, pendingDevices, pendingFolders] =
      await Promise.all([
        client.getSystemStatus(),
        client.getDevices(),
        client.getFolders(),
        client.getPendingDevices(),
        client.getPendingFolders(),
      ]);
    const hasManagedFolder = folders.some(
      (folder) => folder.id === this.settings.folderId,
    );
    const folderStatus = hasManagedFolder
      ? await client.getFolderStatus(this.settings.folderId)
      : undefined;
    return {
      instance,
      reportedDeviceId: system.myID,
      devices,
      folders,
      folderStatus,
      pendingDeviceIds: Object.keys(pendingDevices),
      pendingFolderIds: Object.keys(pendingFolders),
    };
  }

  async refreshReconciliation(force = false): Promise<ReconciliationReport> {
    if (this.reconciliationInProgress) return this.reconciliationReport;
    if (
      !this.settings.onboardingComplete ||
      !this.secretsAreUnlocked() ||
      !this.settings.folderId
    ) {
      return this.reconciliationReport;
    }
    const now = Date.now();
    if (!force && now < this.nextReconciliationAt) {
      return this.reconciliationReport;
    }
    this.nextReconciliationAt = now + TephrameshPlugin.RECONCILIATION_INTERVAL_MS;
    this.reconciliationInProgress = true;
    this.reconciliationReport = {
      state: "checking",
      issues: [],
      repairBlockedReasons: [],
    };
    this.settingTab?.refreshReconciliationReport();
    try {
      const activeInstances = activeMeshInstances(this.settings.instances);
      const settled = await Promise.allSettled(
        activeInstances.map((instance) =>
          this.inspectInstanceForReconciliation(instance),
        ),
      );
      const snapshots: InstanceReconciliationSnapshot[] = [];
      const unavailable: ReconciliationIssue[] = [];
      const invalidPlan: ReconciliationIssue[] = [];
      try {
        createMeshPlan(
          activeInstances,
          this.settings.folderId,
          this.settings.folderLabel,
          this.getShardEncryptionKey() ?? "",
        );
      } catch (error) {
        const instance = activeInstances[0];
        invalidPlan.push({
          instanceId: instance?.id ?? "mesh",
          instanceName: instance?.name ?? "Mesh",
          message: error instanceof Error ? error.message : String(error),
          repairable: false,
        });
      }
      for (const [index, result] of settled.entries()) {
        const instance = activeInstances[index];
        if (!instance) continue;
        if (result.status === "fulfilled") {
          snapshots.push(result.value);
        } else {
          unavailable.push({
            instanceId: instance.id,
            instanceName: instance.name,
            message: `Could not inspect the instance: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
            repairable: false,
          });
        }
      }
      const issues = snapshots.flatMap((snapshot) =>
        inspectReconciliationSnapshot(
          snapshot,
          activeInstances,
          this.settings.folderId,
          this.settings.folderLabel,
          this.getShardEncryptionKey() ?? "",
          this.settings.knownDevices,
        ),
      );
      this.reconciliationReport = {
        state: unavailable.length > 0
          ? "unavailable"
          : invalidPlan.length > 0 || issues.length > 0
            ? "issues"
            : "healthy",
        checkedAt: Date.now(),
        issues: [...unavailable, ...invalidPlan, ...issues],
        repairBlockedReasons: repairBlockedReasons(snapshots),
      };
    } finally {
      this.reconciliationInProgress = false;
      this.settingTab?.refreshReconciliationReport();
    }
    return this.reconciliationReport;
  }

  async repairMesh(): Promise<void> {
    const report = await this.refreshReconciliation(true);
    if (report.state === "unavailable") {
      throw new Error("Every active instance must be reachable before repair.");
    }
    const unsafe = report.issues.filter((issue) => !issue.repairable);
    if (unsafe.length > 0) {
      throw new Error(`Repair is blocked: ${unsafe[0]!.message}`);
    }
    if (report.repairBlockedReasons.length > 0) {
      throw new MeshNotReadyError(report.repairBlockedReasons.join(" "));
    }
    if (report.issues.length === 0) return;

    this.reconciliationReport = { ...report, state: "repairing" };
    this.settingTab?.refreshReconciliationReport();
    try {
      const activeInstances = activeMeshInstances(this.settings.instances);
      const clients = new Map<string, SyncthingClient>();
      for (const instance of activeInstances) {
        const apiKey = this.getApiKey(instance.id);
        if (!apiKey) throw new Error(`API key unavailable for ${instance.name}.`);
        clients.set(instance.id, new SyncthingClient(instance.endpoint, apiKey));
      }

      const folderOrder = [
        ...activeInstances.filter((instance) => instance.kind === "shard"),
        ...activeInstances.filter((instance) => instance.kind === "device"),
      ];
      for (const instance of folderOrder) {
        const client = clients.get(instance.id)!;
        const folders = await client.getFolders();
        const folder = folders.find(
          (candidate) => candidate.id === this.settings.folderId,
        );
        if (!folder) {
          await client.createFolder(
            this.settings.folderId,
            this.settings.folderLabel,
            instance.folderPath,
            instance.kind === "shard" ? "receiveencrypted" : "sendreceive",
          );
        } else if (folder.label !== this.settings.folderLabel) {
          await client.updateFolderLabel(
            this.settings.folderId,
            this.settings.folderLabel,
          );
        }
      }

      const shardKey = this.getShardEncryptionKey() ?? "";
      for (const local of activeInstances) {
        const client = clients.get(local.id)!;
        for (const peer of activeInstances) {
          if (peer.id === local.id) continue;
          const policy = meshPeerPolicy(local, peer, shardKey);
          await client.ensureDevice(
            peer.deviceId,
            peer.name,
            policy.untrusted,
          );
        }
      }
      for (const local of folderOrder) {
        const client = clients.get(local.id)!;
        for (const peer of activeInstances) {
          if (peer.id === local.id) continue;
          const policy = meshPeerPolicy(local, peer, shardKey);
          await client.ensureFolderPeer(
            this.settings.folderId,
            peer.deviceId,
            policy.encryptionPassword,
          );
        }
        const folder = await client.getFolder(this.settings.folderId);
        const expectedIds = new Set(
          activeInstances.map((instance) => instance.deviceId),
        );
        const knownIds = new Set(this.settings.knownDevices.map((known) => known.deviceId));
        for (const folderPeer of folder.devices) {
          if (!expectedIds.has(folderPeer.deviceID)) {
            if (knownIds.has(folderPeer.deviceID)) continue;
            await client.removeFolderPeer(
              this.settings.folderId,
              folderPeer.deviceID,
            );
          }
        }
      }

      const verified = await this.refreshReconciliation(true);
      if (verified.state !== "healthy") {
        throw new Error(
          "Repair was only partially applied. Review the remaining issues and retry.",
        );
      }
    } catch (error) {
      this.nextReconciliationAt = 0;
      if (this.reconciliationReport.state === "repairing") {
        this.reconciliationReport = { ...report, state: "issues" };
        this.settingTab?.refreshReconciliationReport();
      }
      throw error;
    }
  }

  async addKnownDevice(deviceId: string, name: string): Promise<void> {
    const existing = this.settings.knownDevices.find((known) => known.deviceId === deviceId);
    if (existing) {
      existing.name = name || existing.name;
    } else {
      const known: KnownDevice = { deviceId, name: name || "Known device" };
      this.settings.knownDevices.push(known);
    }
    await this.saveSettings();
    await this.refreshReconciliation(true);
    this.settingTab?.rerenderIfVisible();
  }

  async completePendingInstance(candidate: MeshInstance): Promise<void> {
    if (candidate.setupState !== "pending") return;
    await this.assertMeshReadyForInstanceAdd();
    const apiKey = this.getApiKey(candidate.id);
    if (!apiKey) throw new Error(`API key unavailable for ${candidate.name}.`);
    const client = new SyncthingClient(candidate.endpoint, apiKey);
    const [system, devices, folders] = await Promise.all([
      client.getSystemStatus(),
      client.getDevices(),
      client.getFolders(),
    ]);
    if (system.myID !== candidate.deviceId) {
      throw new Error("The pending URL now reports a different Syncthing device ID.");
    }
    const currentName = localSyncthingDeviceName(devices, system.myID);
    if (!currentName) throw new Error("Syncthing did not report its local device name.");
    candidate.name = currentName;

    const normalizePath = (value: string) => value.replace(/[\\/]+$/, "");
    const expectedPath = normalizePath(candidate.folderPath);
    const byId = folders.find((folder) => folder.id === this.settings.folderId);
    const byPath = folders.find(
      (folder) => normalizePath(folder.path) === expectedPath,
    );
    if (byId && normalizePath(byId.path) !== expectedPath) {
      throw new Error(
        `Folder ID “${this.settings.folderId}” already uses a different path on ${candidate.name}.`,
      );
    }
    if (byPath && byPath.id !== this.settings.folderId) {
      throw new Error(
        `The pending path belongs to Syncthing folder “${byPath.id}”.`,
      );
    }
    const expectedType = candidate.kind === "shard" ? "receiveencrypted" : "sendreceive";
    if (byId && byId.type !== expectedType) {
      throw new Error(
        `The managed folder on ${candidate.name} has type “${byId.type}”, expected “${expectedType}”.`,
      );
    }
    if (!byId) {
      await client.createFolder(
        this.settings.folderId,
        this.settings.folderLabel,
        candidate.folderPath,
        expectedType,
      );
    } else if (byId.label !== this.settings.folderLabel) {
      await client.updateFolderLabel(this.settings.folderId, this.settings.folderLabel);
    }

    await this.reconcileNewInstance(candidate);
    delete candidate.setupState;
    await this.saveSettings();
    await this.refreshInstanceStatus(candidate);
  }

  async removeInstance(instance: MeshInstance): Promise<void> {
    if (!canRemoveInstance(this.settings.instances, instance)) {
      throw new Error("The last active device cannot be removed.");
    }
    const remaining = this.settings.instances.filter(
      (candidate) => candidate.id !== instance.id,
    );
    const remainingActive = activeMeshInstances(remaining);
    const replacementPrimary = remainingActive.find(
      (candidate) => candidate.kind === "device",
    );
    const removedApiKey = this.getApiKey(instance.id);
    if (!removedApiKey) {
      throw new Error(`API key unavailable for ${instance.name}.`);
    }
    const removedClient = new SyncthingClient(instance.endpoint, removedApiKey);
    const remainingClients = remainingActive.map((candidate) => {
      const apiKey = this.getApiKey(candidate.id);
      if (!apiKey) throw new Error(`API key unavailable for ${candidate.name}.`);
      return new SyncthingClient(candidate.endpoint, apiKey);
    });

    if (instance.setupState === "pending") {
      await Promise.all([
        removedClient.getSystemStatus(),
        ...remainingClients.map((client) => client.getSystemStatus()),
      ]);
      for (const client of remainingClients) {
        await client.removeFolderPeer(this.settings.folderId, instance.deviceId);
      }
      const pendingFolder = await removedClient
        .getFolder(this.settings.folderId)
        .catch((error: unknown) => {
          if (error instanceof SyncthingApiError && error.status === 404) {
            return undefined;
          }
          throw error;
        });
      if (pendingFolder) await removedClient.removeFolder(this.settings.folderId);
      this.settings.instances = remaining;
      if (instance.id === this.settings.primaryInstanceId && replacementPrimary) {
        this.settings.primaryInstanceId = replacementPrimary.id;
      }
      this.runtimeStatuses.delete(instance.id);
      if (!this.secrets) throw new Error("Unlock Tephramesh secrets first.");
      delete this.secrets.apiKeys[instance.id];
      await this.persistSecrets();
      return;
    }

    // Verify every required API and folder before changing any configuration.
    await Promise.all([
      removedClient.getFolder(this.settings.folderId),
      ...remainingClients.map((client) => client.getFolder(this.settings.folderId)),
    ]);
    for (const client of remainingClients) {
      await client.removeFolderPeer(this.settings.folderId, instance.deviceId);
    }
    await removedClient.removeFolder(this.settings.folderId);

    this.settings.instances = remaining;
    if (instance.id === this.settings.primaryInstanceId && replacementPrimary) {
      this.settings.primaryInstanceId = replacementPrimary.id;
    }
    this.runtimeStatuses.delete(instance.id);
    if (!this.secrets) throw new Error("Unlock Tephramesh secrets first.");
    delete this.secrets.apiKeys[instance.id];
    await this.persistSecrets();
  }

  restartPolling(): void {
    if (this.pollingTimer !== undefined) {
      window.clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    if (!this.statusPollingEnabled) return;
    const milliseconds = Math.max(1, this.settings.pollIntervalSeconds) * 1000;
    this.pollingTimer = window.setInterval(() => void this.refreshStatuses(), milliseconds);
  }

  startStatusPolling(): void {
    if (this.statusPollingEnabled) return;
    this.statusPollingEnabled = true;
    this.restartPolling();
    void this.refreshStatuses(true);
  }

  stopStatusPolling(): void {
    this.statusPollingEnabled = false;
    if (this.pollingTimer !== undefined) {
      window.clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  restartNoteSyncPolling(): void {
    if (this.noteSyncTimer !== undefined) window.clearInterval(this.noteSyncTimer);
    this.fileExplorerObserver?.disconnect();
    this.fileExplorerObserver = new MutationObserver(() => {
      this.renderNoteSyncBadges();
    });
    this.fileExplorerObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    this.noteSyncTimer = window.setInterval(
      () => void this.refreshNoteSyncBadges(),
      Math.max(1, this.settings.noteSyncPollIntervalSeconds) * 1000,
    );
    void this.refreshNoteSyncBadges();
  }

  private async refreshNoteSyncBadges(): Promise<void> {
    if (this.noteSyncRefreshInProgress) return;
    if (
      !this.settings.onboardingComplete ||
      !this.secretsAreUnlocked() ||
      !this.settings.folderId
    ) {
      this.pendingNotePaths.clear();
      this.renderNoteSyncBadges();
      return;
    }

    const activeInstances = activeMeshInstances(this.settings.instances);
    if (activeInstances.length < 2) {
      this.pendingNotePaths.clear();
      this.renderNoteSyncBadges();
      return;
    }

    const primary = activeInstances.find(
      (instance) => instance.id === this.settings.primaryInstanceId,
    );
    const sources = [
      ...(primary ? [primary] : []),
      ...activeInstances.filter(
        (instance) => instance.id !== primary?.id && instance.kind === "device",
      ),
    ].filter((instance) => instance.kind === "device");

    this.noteSyncRefreshInProgress = true;
    try {
      for (const source of sources) {
        const apiKey = this.getApiKey(source.id);
        if (!apiKey) continue;
        try {
          const client = new SyncthingClient(source.endpoint, apiKey);
          const neededByPeer = await Promise.all([
            client.getLocalNeededFiles(this.settings.folderId),
            ...activeInstances
              .filter((peer) => peer.id !== source.id)
              .map((peer) =>
                client.getRemoteNeededFiles(this.settings.folderId, peer.deviceId),
              ),
          ]);
          this.pendingNotePaths = new Set(
            neededByPeer
              .flat()
              .map((path) => path.replaceAll("\\", "/"))
              .filter((path) => path.toLowerCase().endsWith(".md")),
          );
          this.renderNoteSyncBadges();
          return;
        } catch {
          // Try another active instance without clearing the last known badges.
        }
      }
    } finally {
      this.noteSyncRefreshInProgress = false;
    }
  }

  private renderNoteSyncBadges(): void {
    for (const title of Array.from(
      document.querySelectorAll<HTMLElement>(".nav-file-title[data-path]"),
    )) {
      const path = title.dataset.path?.replaceAll("\\", "/");
      const existing = title.querySelector(
        ":scope > .tephramesh-note-sync-icon",
      ) as HTMLElement | null;
      if (!path || !this.pendingNotePaths.has(path)) {
        existing?.remove();
        title.classList.remove("tephramesh-note-sync-pending");
        title.removeAttribute("aria-label");
        continue;
      }
      title.classList.add("tephramesh-note-sync-pending");
      title.setAttribute("aria-label", `${path} — waiting to sync`);
      if (existing) continue;
      const icon = title.createSpan({
        cls: "tephramesh-note-sync-icon",
        attr: { "aria-hidden": "true" },
      });
      setIcon(icon, "refresh-cw");
      title.prepend(icon);
    }

    const pendingFolders = pendingFolderPaths(this.pendingNotePaths);
    for (const title of Array.from(
      document.querySelectorAll<HTMLElement>(".nav-folder-title[data-path]"),
    )) {
      const path = title.dataset.path?.replaceAll("\\", "/");
      const existing = title.querySelector(
        ":scope > .tephramesh-folder-sync-icon",
      ) as HTMLElement | null;
      if (!path || !pendingFolders.has(path)) {
        existing?.remove();
        title.classList.remove("tephramesh-folder-sync-pending");
        title.removeAttribute("aria-label");
        continue;
      }
      title.classList.add("tephramesh-folder-sync-pending");
      title.setAttribute("aria-label", `${path} — contains notes waiting to sync`);
      if (existing) continue;
      const icon = title.createSpan({
        cls: "tephramesh-folder-sync-icon",
        attr: { "aria-hidden": "true" },
      });
      setIcon(icon, "refresh-cw");
      title.prepend(icon);
    }
  }

  private clearNoteSyncBadges(): void {
    for (const title of Array.from(
      document.querySelectorAll<HTMLElement>(
        ".nav-file-title.tephramesh-note-sync-pending",
      ),
    )) {
      title.querySelector(":scope > .tephramesh-note-sync-icon")?.remove();
      title.classList.remove("tephramesh-note-sync-pending");
      title.removeAttribute("aria-label");
    }
    for (const title of Array.from(
      document.querySelectorAll<HTMLElement>(
        ".nav-folder-title.tephramesh-folder-sync-pending",
      ),
    )) {
      title.querySelector(":scope > .tephramesh-folder-sync-icon")?.remove();
      title.classList.remove("tephramesh-folder-sync-pending");
      title.removeAttribute("aria-label");
    }
  }

  scheduleFolderLabelSync(): void {
    if (this.folderLabelSyncTimer !== undefined) {
      window.clearTimeout(this.folderLabelSyncTimer);
    }
    this.folderLabelSyncTimer = window.setTimeout(() => {
      this.folderLabelSyncTimer = undefined;
      const desiredLabel = this.settings.folderLabel;
      this.folderLabelSyncQueue = this.folderLabelSyncQueue.then(async () => {
        if (desiredLabel !== this.settings.folderLabel) return;
        await this.syncFolderLabelToAll(desiredLabel);
      });
    }, TephrameshPlugin.LABEL_SYNC_DEBOUNCE_MS);
  }

  private async syncFolderLabelToAll(label: string): Promise<void> {
    const activeInstances = activeMeshInstances(this.settings.instances);
    if (!this.settings.folderId || activeInstances.length === 0) return;
    const results = await Promise.allSettled(
      activeInstances.map(async (instance) => {
        const apiKey = this.getApiKey(instance.id);
        if (!apiKey) throw new Error("API key unavailable");
        const client = new SyncthingClient(instance.endpoint, apiKey);
        await client.updateFolderLabel(this.settings.folderId, label);
        return instance.name;
      }),
    );
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [activeInstances[index]?.name ?? "Unknown instance"]
        : [],
    );
    const updated = results.length - failures.length;
    if (failures.length === 0) {
      showTephrameshNotice(
        "success",
        "Folder label updated",
        `Updated ${updated} Syncthing instance${updated === 1 ? "" : "s"}.`,
      );
    } else {
      showTephrameshNotice(
        "warning",
        "Folder label partially updated",
        `Updated ${updated} of ${results.length}. Could not update: ${failures.join(", ")}. Tephramesh will retry during periodic refresh.`,
      );
    }
  }

  setKnownHealthy(instanceId: string, version: string): void {
    this.runtimeStatuses.set(instanceId, {
      checkedAt: Date.now(),
      ok: true,
      version,
    });
  }

  async refreshStatuses(forceNameCheck = false): Promise<void> {
    if (
      this.refreshInProgress ||
      !this.settings.onboardingComplete ||
      !this.secretsAreUnlocked()
    ) return;
    this.refreshInProgress = true;
    try {
      const now = Date.now();
      const checkNames = forceNameCheck || now >= this.nextNameRefreshAt;
      if (checkNames) {
        this.nextNameRefreshAt = now + TephrameshPlugin.NAME_REFRESH_INTERVAL_MS;
      }
      const nameChanges = await Promise.all(
        this.settings.instances.map((instance) =>
          this.refreshInstanceStatus(instance, false, checkNames),
        ),
      );
      if (nameChanges.some(Boolean)) {
        await this.saveSettings();
        this.settingTab.rerenderIfVisible();
      }
    } finally {
      this.refreshInProgress = false;
      this.settingTab.refreshRuntimeStatuses(this.runtimeStatuses);
      void this.refreshReconciliation();
    }
  }

  async refreshInstanceStatus(
    instance: MeshInstance,
    render = true,
    checkName = true,
  ): Promise<boolean> {
    let nameChanged = false;
    try {
      const apiKey = this.getApiKey(instance.id);
      if (!apiKey) throw new Error("API key is unavailable in the encrypted configuration");
      const client = new SyncthingClient(instance.endpoint, apiKey);
      const [system, version, connections, initialFolderStatus, devices, folderConfig] = await Promise.all([
        client.getSystemStatus(),
        client.getVersion(),
        client.getConnections(),
        this.settings.folderId
          ? client.getFolderStatus(this.settings.folderId).catch(() => undefined)
          : Promise.resolve(undefined),
        checkName ? client.getDevices() : Promise.resolve(undefined),
        instance.setupState !== "pending" &&
          this.settings.folderId
          ? client.getFolder(this.settings.folderId).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      const folder =
        initialFolderStatus?.state === "scanning"
          ? {
              ...initialFolderStatus,
              scanProgress: await client
                .getFolderScanProgress(
                  this.settings.folderId,
                  initialFolderStatus.stateChanged,
                )
                .catch(() => undefined),
            }
          : initialFolderStatus;
      const pendingFiles =
        instance.kind === "device" &&
        instance.setupState !== "pending" &&
        (folder?.needFiles ?? 0) > 0
          ? await client.getLocalNeededFiles(this.settings.folderId)
              .catch(() => undefined)
          : undefined;
      if (system.myID !== instance.deviceId) {
        throw new Error("API now reports a different Syncthing device ID");
      }
      if (devices) {
        const currentName = localSyncthingDeviceName(devices, system.myID);
        if (!currentName) {
          throw new Error("Syncthing did not report a name for its local device");
        }
        if (currentName !== instance.name) {
          instance.name = currentName;
          nameChanged = true;
        }
      }
      if (folderConfig && folderConfig.label !== this.settings.folderLabel) {
        await client.updateFolderLabel(
          this.settings.folderId,
          this.settings.folderLabel,
        );
      }
      const checkedAt = Date.now();
      const traffic = {
        sampledAt: checkedAt,
        inBytesTotal: connections.total.inBytesTotal,
        outBytesTotal: connections.total.outBytesTotal,
      };
      const rates = trafficRates(
        this.runtimeStatuses.get(instance.id)?.traffic,
        traffic,
      );
      this.runtimeStatuses.set(instance.id, {
        checkedAt,
        ok: true,
        version: version.version,
        deviceId: system.myID,
        folder,
        folderPaused: Boolean(folderConfig?.paused),
        pendingFiles,
        traffic,
        ...rates,
      });
    } catch (error) {
      this.runtimeStatuses.set(instance.id, {
        checkedAt: Date.now(),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (render) {
      if (nameChanged) {
        await this.saveSettings();
        this.settingTab.rerenderIfVisible();
      }
      this.settingTab.refreshRuntimeStatuses(this.runtimeStatuses);
    }
    return nameChanged;
  }

  async setInstanceFolderPaused(
    instance: MeshInstance,
    paused: boolean,
  ): Promise<void> {
    if (instance.setupState === "pending") {
      throw new Error("Complete this instance's setup before pausing its folder.");
    }
    const apiKey = this.getApiKey(instance.id);
    if (!apiKey) {
      throw new Error("API key is unavailable in the encrypted configuration");
    }
    await new SyncthingClient(instance.endpoint, apiKey).setFolderPaused(
      this.settings.folderId,
      paused,
    );
    await this.refreshInstanceStatus(instance);
    this.nextReconciliationAt = 0;
  }
}
