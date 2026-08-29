import { normalizePath, Plugin, setIcon } from "obsidian";
import { DEFAULT_SETTINGS, normalizeInstanceDisplayOrder, type InstanceRuntimeStatus, type MeshInstance, type TephrameshSettings, type KnownDevice } from "./model";
import { TephrameshSettingTab } from "./settings-tab";
import { SyncthingApiError, SyncthingClient } from "./syncthing-client";
import { showTephrameshNotice } from "./notices";
import { localSyncthingDeviceName } from "./syncthing-device";
import { MeshNotReadyError } from "./mesh-errors";
import { generateShardPassword } from "./security";
import { trafficRates } from "./syncthing-traffic";
import {
  activeMeshInstances,
  canRemoveInstance,
  createMeshPlan,
  isRuntimeStatusFresh,
  meshPeerPolicy,
} from "./topology";
import { pendingFolderPaths, pendingNotePathsForHostThreshold } from "./note-sync";
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
  type TephrameshSecrets,
  type TephrameshProtectedData,
  validateAgeKeyPair,
} from "./secret-bundle";
import {
  createConfigHistoryBlock,
  decryptConfigHistory,
  DEFAULT_CONFIG_HISTORY_VERSIONS,
  isConfigHistoryEnvelope,
  encryptConfigHistory,
  normalizeConfigHistoryVersions,
  repairAliasedConfigHistory,
  verifyConfigHistory,
  type ConfigHistoryBlock,
  type ConfigHistoryEnvelope,
} from "./config-history";
import {
  approveEnrollmentRequest,
  assertSignedRevisionAccepted,
  createEnrollmentRequest,
  createEnrollmentApproval,
  createGenesisEnrollment,
  createSignedConfigEnvelope,
  decodeEnrollmentApproval,
  decodeEnrollmentRequest,
  DEVICE_SIGNING_SECRET_NAME,
  encodeEnrollmentCode,
  generateSigningKeyPair,
  isSignedConfigEnvelope,
  sha256Canonical,
  verifyEnrollmentApproval,
  verifySignedConfigEnvelope,
  type DeviceEnrollment,
  type LocalDeviceSigningRecord,
} from "./config-signing";

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

interface LegacyShardEncryptionKeyHash {
  shardEncryptionKeyHash?: string;
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
  private configHistoryBlocks: ConfigHistoryBlock[] = [];
  private signingRootKeyId = "";
  private signingEnrollments: DeviceEnrollment[] = [];
  private signedConfigRevision = 0;
  private signedConfigHash = "";
  private signingTrust: "unsigned" | "approval-required" | "enrolled" = "unsigned";
  private storageFormat: 2 | 3 = 3;
  private settingTab!: TephrameshSettingTab;
  private pollingTimer?: number;
  private statusPollingEnabled = false;
  private noteSyncTimer?: number;
  private noteSyncRefreshInProgress = false;
  private pendingNotePaths = new Set<string>();
  private fileExplorerObserver?: MutationObserver;
  private refreshInProgress = false;
  private forcedStatusRefreshPending = false;
  /**
   * A requestUrl call cannot be aborted. Keep timed-out instance checks in
   * flight and reuse them instead of starting another batch of requests on
   * every polling tick.
   */
  private instanceStatusChecks = new Map<string, Promise<boolean>>();
  private nextInstanceMetadataRefreshAt = 0;
  private nextReconciliationAt = 0;
  private reconciliationInProgress = false;
  private reconciliationChecks = new Map<string, Promise<InstanceReconciliationSnapshot>>();
  private folderLabelSyncTimer?: number;
  private folderLabelSyncQueue: Promise<void> = Promise.resolve();
  private static readonly INSTANCE_METADATA_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
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
    this.resetSigningRuntimeState();
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
      this.configHistoryBlocks = [];
      this.storageFormat = 3;
      return;
    }
    const legacy = stored as LegacyEncryptedSettings | null;
    const {
      shardEncryptionKeyHash: _legacyShardEncryptionKeyHash,
      ...legacySettings
    } = (legacy ?? {}) as LegacyEncryptedSettings & LegacyShardEncryptionKeyHash;
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...legacySettings,
      instances: normalizeInstanceDisplayOrder(legacySettings.instances),
      schemaVersion: 3,
    };
    this.encryptedData =
      legacy && "encryptedSecrets" in legacy
        ? legacy.encryptedSecrets ?? ""
        : "";
    this.storageFormat = 2;
    this.configHistoryBlocks = [];
  }

  async saveSettings(): Promise<void> {
    if (!this.secrets || !this.settings.ageRecipient) {
      throw new Error("Unlock Tephramesh encryption before saving settings.");
    }
    const {
      ageRecipient,
      schemaVersion: _envelopeSchemaVersion,
      ...protectedSettings
    } = this.settings;
    const protectedData = {
      schemaVersion: 1,
      settings: protectedSettings,
      secrets: this.secrets,
    } as const;
    const retention = normalizeConfigHistoryVersions(this.settings.configHistoryVersions || DEFAULT_CONFIG_HISTORY_VERSIONS);
    const configHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(protectedData)));
    const serializedHash = Array.from(new Uint8Array(configHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const previous = this.configHistoryBlocks.at(-1);
    let blocks = this.configHistoryBlocks;
    if (previous?.configHash !== serializedHash) {
      blocks = [...blocks, await createConfigHistoryBlock(protectedData, previous)];
    }
    blocks = blocks.slice(-retention);
    const history: ConfigHistoryEnvelope = {
      format: "tephramesh-config-history-v1",
      retention,
      blocks,
    };
    let encryptedPayload: unknown = history;
    let nextSignedEnvelope:
      | Awaited<ReturnType<typeof createSignedConfigEnvelope>>
      | undefined;
    let nextSignedHash = "";
    let localSigning = this.getLocalSigningRecord();
    if (this.signingRootKeyId) {
      if (!localSigning?.rootKeyId) {
        throw new Error(
          "Enroll this Obsidian installation before changing the signed Tephramesh configuration.",
        );
      }
      nextSignedEnvelope = await createSignedConfigEnvelope(
        history,
        this.signingEnrollments,
        this.signingRootKeyId,
        this.signedConfigRevision + 1,
        localSigning,
      );
      nextSignedHash = await sha256Canonical(nextSignedEnvelope);
      encryptedPayload = nextSignedEnvelope;
    }
    const encryptedData = await encryptConfigHistory(ageRecipient, encryptedPayload);
    this.storageFormat = 3;
    await this.saveData({
      schemaVersion: 3,
      ageRecipient,
      encryptedData,
    } satisfies EncryptedSettingsEnvelope);
    this.configHistoryBlocks = blocks;
    this.encryptedData = encryptedData;
    if (nextSignedEnvelope && localSigning) {
      this.signedConfigRevision = nextSignedEnvelope.revision;
      this.signedConfigHash = nextSignedHash;
      this.signingTrust = "enrolled";
      localSigning = {
        ...localSigning,
        pendingRequest: undefined,
        pendingApproval: undefined,
        lastAcceptedRevision: nextSignedEnvelope.revision,
        lastAcceptedEnvelopeHash: nextSignedHash,
      };
      this.setLocalSigningRecord(localSigning);
    }
  }

  async deleteConfig(): Promise<void> {
    if (this.signingTrust !== "enrolled") {
      throw new Error("This installation must be enrolled for configuration signing before deleting config.");
    }
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
    this.resetSigningRuntimeState();
    this.app.secretStorage.setSecret(DEVICE_SIGNING_SECRET_NAME, "");
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

  getDecryptedConfig(): TephrameshProtectedData | null {
    if (!this.secrets) return null;
    const {
      ageRecipient: _ageRecipient,
      schemaVersion: _envelopeSchemaVersion,
      ...settings
    } = this.settings;
    return {
      schemaVersion: 1,
      settings: structuredClone(settings),
      secrets: structuredClone(this.secrets),
    };
  }

  getConfigHistory(): ConfigHistoryBlock[] {
    if (!this.secrets) return [];
    return structuredClone(this.configHistoryBlocks).reverse();
  }

  getSigningEnvironmentStatus(): {
    state: "unsigned" | "approval-required" | "enrolled";
    rootKeyId: string;
    revision: number;
    localInstallationName?: string;
    pendingRequestCode?: string;
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
    }>;
  } {
    const local = this.getLocalSigningRecord();
    const installationOptions = this.getAllSigningInstallationOptions();
    const enrollmentByKeyId = new Map(
      this.signingEnrollments.map((enrollment) => [enrollment.keyId, enrollment]),
    );
    const installationForEnrollment = (bindingId: string, deviceId: string) =>
      installationOptions.find((option) => option.bindingId === bindingId) ??
      installationOptions.find((option) => option.deviceId === deviceId);
    return {
      state: this.signingTrust,
      rootKeyId: this.signingRootKeyId,
      revision: this.signedConfigRevision,
      localInstallationName: local
        ? this.getAllSigningInstallationOptions().find(
            (option) => option.bindingId === local.bindingId,
          )?.name
        : undefined,
      pendingRequestCode: local?.pendingRequest
        ? encodeEnrollmentCode(local.pendingRequest)
        : undefined,
      pendingInstallation: local?.pendingRequest
        ? (() => {
            const installation = installationForEnrollment(
              local.pendingRequest.bindingId,
              local.pendingRequest.deviceId,
            );
            return {
              bindingId: local.pendingRequest.bindingId,
              deviceId: local.pendingRequest.deviceId,
              keyId: local.pendingRequest.keyId,
              name: installation?.name ?? "Unconfigured device",
              source: installation?.source ?? "unconfigured",
            };
          })()
        : undefined,
      authenticatedInstallations: this.signingEnrollments.map((enrollment) => {
        const installation = installationForEnrollment(
          enrollment.bindingId,
          enrollment.deviceId,
        );
        const approverEnrollment = enrollmentByKeyId.get(
          enrollment.approvedByKeyId,
        );
        const approverInstallation = approverEnrollment
          ? installationForEnrollment(
              approverEnrollment.bindingId,
              approverEnrollment.deviceId,
            )
          : undefined;
        return {
          bindingId: enrollment.bindingId,
          deviceId: enrollment.deviceId,
          keyId: enrollment.keyId,
          name: installation?.name ?? "Unconfigured device",
          source: installation?.source ?? "unconfigured",
          isLocal: local?.keyId === enrollment.keyId,
          createdAt: enrollment.createdAt,
          approvedByName: approverInstallation?.name,
          isEnrollmentRoot: enrollment.keyId === this.signingRootKeyId,
        };
      }),
    };
  }

  getSigningInstallationOptions(): Array<{
    bindingId: string;
    deviceId: string;
    name: string;
    source: "mesh" | "known";
  }> {
    return this.getAllSigningInstallationOptions().filter((installation) => {
      const enrolled = this.signingEnrollments.some(
        (enrollment) =>
          enrollment.bindingId === installation.bindingId ||
          enrollment.deviceId === installation.deviceId,
      );
      return !enrolled;
    });
  }

  private getAllSigningInstallationOptions(): Array<{
    bindingId: string;
    deviceId: string;
    name: string;
    source: "mesh" | "known";
  }> {
    const activeDevices = activeMeshInstances(this.settings.instances)
      .filter((instance) => instance.kind === "device")
      .map((instance) => ({
        bindingId: `mesh:${instance.id}`,
        deviceId: instance.deviceId,
        name: instance.name,
        source: "mesh" as const,
      }));
    const activeIds = new Set(activeDevices.map((device) => device.deviceId));
    const knownDevices = this.settings.knownDevices
      .filter((known) => !activeIds.has(known.deviceId))
      .map((known) => ({
        bindingId: `known:${known.deviceId}`,
        deviceId: known.deviceId,
        name: known.name,
        source: "known" as const,
      }));
    return [...activeDevices, ...knownDevices];
  }

  async initializeSigningEnvironment(bindingId: string): Promise<void> {
    if (this.signingRootKeyId || this.signingTrust !== "unsigned") {
      throw new Error("Configuration signing is already initialized.");
    }
    const installation = this.requireSigningInstallation(bindingId);
    const existing = this.getLocalSigningRecord();
    if (existing?.rootKeyId || existing?.pendingRequest) {
      throw new Error("This installation already has device signing state.");
    }
    const keys = await generateSigningKeyPair();
    const enrollment = await createGenesisEnrollment(
      installation.bindingId,
      installation.deviceId,
      keys,
    );
    const record: LocalDeviceSigningRecord = {
      format: "tephramesh-local-device-signing-v1",
      bindingId: installation.bindingId,
      deviceId: installation.deviceId,
      rootKeyId: keys.keyId,
      ...keys,
    };
    this.setLocalSigningRecord(record);
    this.signingRootKeyId = keys.keyId;
    this.signingEnrollments = [enrollment];
    this.signingTrust = "enrolled";
    await this.saveSettings();
  }

  async generateEnrollmentRequest(bindingId: string): Promise<string> {
    if (!this.signingRootKeyId || this.signingTrust !== "approval-required") {
      throw new Error("This installation does not need enrollment approval.");
    }
    const installation = this.requireSigningInstallation(bindingId);
    const existing = this.getLocalSigningRecord();
    if (existing?.rootKeyId) throw new Error("This installation is already enrolled.");
    const keys = await generateSigningKeyPair();
    const request = createEnrollmentRequest(
      installation.bindingId,
      installation.deviceId,
      keys,
    );
    const record: LocalDeviceSigningRecord = {
      format: "tephramesh-local-device-signing-v1",
      bindingId: installation.bindingId,
      deviceId: installation.deviceId,
      pendingRequest: request,
      ...keys,
    };
    this.setLocalSigningRecord(record);
    return encodeEnrollmentCode(request);
  }

  async approveEnrollmentCode(code: string): Promise<string> {
    if (this.signingTrust !== "enrolled" || !this.signingRootKeyId) {
      throw new Error("Only an enrolled installation can approve another device.");
    }
    const local = this.getLocalSigningRecord();
    if (!local?.rootKeyId) throw new Error("The local signing key is unavailable.");
    const request = decodeEnrollmentRequest(code);
    const installation = this.requireSigningInstallation(request.bindingId);
    if (installation.deviceId !== request.deviceId) {
      throw new Error("The enrollment request does not match that configured device.");
    }
    if (this.signingEnrollments.some(
      (enrollment) => enrollment.keyId === request.keyId,
    )) {
      throw new Error("That signing key is already enrolled.");
    }
    const enrollment = await approveEnrollmentRequest(request, local);
    const approval = await createEnrollmentApproval(
      this.signingRootKeyId,
      this.signedConfigRevision,
      this.signedConfigHash,
      request,
      [...structuredClone(this.signingEnrollments), enrollment],
      local,
    );
    return encodeEnrollmentCode(approval);
  }

  reviewEnrollmentCode(code: string): {
    bindingId: string;
    deviceId: string;
    deviceName: string;
    source: "mesh" | "known";
    keyId: string;
  } {
    if (this.signingTrust !== "enrolled" || !this.signingRootKeyId) {
      throw new Error("Only an enrolled installation can review enrollment requests.");
    }
    const request = decodeEnrollmentRequest(code);
    const installation = this.requireSigningInstallation(request.bindingId);
    if (installation.deviceId !== request.deviceId) {
      throw new Error("The enrollment request does not match that configured device.");
    }
    return {
      bindingId: request.bindingId,
      deviceId: request.deviceId,
      deviceName: installation.name,
      source: installation.source,
      keyId: request.keyId,
    };
  }

  async completeEnrollment(code: string): Promise<void> {
    if (this.signingTrust !== "approval-required" || !this.signingRootKeyId) {
      throw new Error("This installation is not waiting for enrollment approval.");
    }
    const local = this.getLocalSigningRecord();
    if (!local?.pendingRequest) {
      throw new Error("Generate an enrollment request on this installation first.");
    }
    const approval = decodeEnrollmentApproval(code);
    await verifyEnrollmentApproval(approval, local);
    if (approval.rootKeyId !== this.signingRootKeyId) {
      throw new Error("The approval belongs to a different signing environment.");
    }
    if (approval.approvedRevision !== this.signedConfigRevision ||
        approval.approvedEnvelopeHash !== this.signedConfigHash) {
      throw new Error(
        "The signed configuration changed after this approval was created. Generate a new request and approval.",
      );
    }
    const enrolled: LocalDeviceSigningRecord = {
      ...local,
      rootKeyId: approval.rootKeyId,
      pendingApproval: approval,
      lastAcceptedRevision: approval.approvedRevision,
      lastAcceptedEnvelopeHash: approval.approvedEnvelopeHash,
    };
    this.signingEnrollments = structuredClone(approval.enrollments);
    this.setLocalSigningRecord(enrolled);
    this.signingTrust = "enrolled";
    await this.saveSettings();
  }

  async restoreConfigVersion(version: number): Promise<void> {
    if (!this.secrets) throw new Error("Unlock Tephramesh encryption before restoring a config version.");
    await verifyConfigHistory(this.configHistoryBlocks);
    const block = this.configHistoryBlocks.find((candidate) => candidate.version === version);
    if (!block) throw new Error(`Config version ${version} is no longer available.`);

    const recipient = this.settings.ageRecipient;
    const historyVersions = this.settings.configHistoryVersions;
    this.applyProtectedData(block.config, recipient);
    // Restoring operational state must not silently change the user's current
    // history-retention policy or discard versions during the restore itself.
    this.settings.configHistoryVersions = historyVersions;
    await this.saveSettings();
    this.runtimeStatuses.clear();
    this.reconciliationReport = { state: "checking", issues: [], repairBlockedReasons: [] };
    this.restartPolling();
    this.restartNoteSyncPolling();
    if (this.statusPollingEnabled) void this.refreshStatuses(true);
    void this.refreshReconciliation(true);
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
    migrated.shardEncryptionKey = legacyShardKey ?? "";
    if (!migrated.shardEncryptionKey) {
      migrated.shardEncryptionKey = generateShardPassword();
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
      const decrypted = await decryptConfigHistory(identity, this.encryptedData);
      let protectedData: TephrameshProtectedData;
      if (isSignedConfigEnvelope(decrypted)) {
        const verified = await verifySignedConfigEnvelope(decrypted);
        const local = this.getLocalSigningRecord();
        let enrolledLocal: LocalDeviceSigningRecord | undefined;
        let completePendingApproval = false;
        if (local?.rootKeyId) {
          if (local.rootKeyId !== verified.envelope.rootKeyId) {
            throw new Error("The signed configuration uses a different enrollment root.");
          }
          assertSignedRevisionAccepted(
            local,
            verified.envelope.revision,
            verified.hash,
          );
          const enrollment = verified.envelope.enrollments.find(
            (candidate) => candidate.keyId === local.keyId,
          );
          if (!enrollment) {
            if (!local.pendingApproval || !local.pendingRequest) {
              throw new Error("This installation's signing key is not enrolled.");
            }
            await verifyEnrollmentApproval(local.pendingApproval, local);
            if (local.pendingApproval.approvedRevision !== verified.envelope.revision ||
                local.pendingApproval.approvedEnvelopeHash !== verified.hash) {
              throw new Error("The pending enrollment approval is stale.");
            }
            this.signingEnrollments = structuredClone(
              local.pendingApproval.enrollments,
            );
            completePendingApproval = true;
          } else if (enrollment.deviceId !== local.deviceId ||
                     enrollment.bindingId !== local.bindingId) {
            throw new Error("This installation's signing key has the wrong device binding.");
          }
          this.signingTrust = "enrolled";
          enrolledLocal = {
            ...local,
            lastAcceptedRevision: verified.envelope.revision,
            lastAcceptedEnvelopeHash: verified.hash,
          };
        } else {
          this.signingTrust = "approval-required";
        }
        this.signingRootKeyId = verified.envelope.rootKeyId;
        if (!completePendingApproval) {
          this.signingEnrollments = structuredClone(verified.envelope.enrollments);
        }
        this.signedConfigRevision = verified.envelope.revision;
        this.signedConfigHash = verified.hash;
        const repairedHistory = await this.loadHistoryEnvelope(
          verified.envelope.history,
          recipient,
          true,
        );
        if (enrolledLocal) this.setLocalSigningRecord(enrolledLocal);
        if (completePendingApproval || (repairedHistory && enrolledLocal)) {
          await this.saveSettings();
        }
        return;
      }
      if (isConfigHistoryEnvelope(decrypted)) {
        const local = this.getLocalSigningRecord();
        if (local?.rootKeyId) {
          if (local.lastAcceptedRevision) {
            throw new Error("An unsigned configuration cannot replace signed Tephramesh state.");
          }
          const genesis = await createGenesisEnrollment(
            local.bindingId,
            local.deviceId,
            local,
          );
          this.signingRootKeyId = local.rootKeyId;
          this.signingEnrollments = [genesis];
          this.signingTrust = "enrolled";
          await this.loadHistoryEnvelope(decrypted, recipient, true);
          await this.saveSettings();
          return;
        }
        const repairedHistory = await this.loadHistoryEnvelope(
          decrypted,
          recipient,
          true,
        );
        if (repairedHistory) await this.saveSettings();
        return;
      } else {
        if (this.getLocalSigningRecord()?.rootKeyId) {
          throw new Error("An unsigned configuration cannot replace signed Tephramesh state.");
        }
        this.configHistoryBlocks = [];
        protectedData = await decryptProtectedData(identity, this.encryptedData);
      }
      this.applyProtectedData(protectedData, recipient);
      return;
    }
    if (this.getLocalSigningRecord()?.rootKeyId) {
      throw new Error("Legacy unsigned configuration cannot replace signed Tephramesh state.");
    }
    this.secrets = await decryptSecrets(identity, this.encryptedData);
    await this.saveSettings();
  }

  private async loadHistoryEnvelope(
    history: ConfigHistoryEnvelope,
    recipient: string,
    repairLegacyAliasing: boolean,
  ): Promise<boolean> {
    let blocks = history.blocks;
    let repairedAliasedHistory = false;
    try {
      await verifyConfigHistory(blocks);
    } catch {
      if (!repairLegacyAliasing) {
        throw new Error(
          "The signed Tephramesh configuration history failed integrity verification.",
        );
      }
      blocks = await repairAliasedConfigHistory(blocks);
      repairedAliasedHistory = true;
    }
    this.configHistoryBlocks = blocks.slice(
      -normalizeConfigHistoryVersions(this.settings.configHistoryVersions),
    );
    const protectedData = this.configHistoryBlocks.at(-1)?.config;
    if (!protectedData) {
      throw new Error("The Tephramesh configuration history has no versions.");
    }
    this.applyProtectedData(protectedData, recipient);
    return repairedAliasedHistory;
  }

  private resetSigningRuntimeState(): void {
    this.signingRootKeyId = "";
    this.signingEnrollments = [];
    this.signedConfigRevision = 0;
    this.signedConfigHash = "";
    this.signingTrust = "unsigned";
  }

  private getLocalSigningRecord(): LocalDeviceSigningRecord | null {
    const stored = this.app.secretStorage.getSecret(DEVICE_SIGNING_SECRET_NAME);
    if (!stored) return null;
    try {
      const value = JSON.parse(stored) as Partial<LocalDeviceSigningRecord>;
      if (value.format !== "tephramesh-local-device-signing-v1" ||
          !value.bindingId || !value.deviceId || !value.keyId ||
          !value.publicKey || !value.privateKey) return null;
      return value as LocalDeviceSigningRecord;
    } catch {
      return null;
    }
  }

  private setLocalSigningRecord(record: LocalDeviceSigningRecord): void {
    this.app.secretStorage.setSecret(
      DEVICE_SIGNING_SECRET_NAME,
      JSON.stringify(record),
    );
  }

  private requireSigningInstallation(bindingId: string): {
    bindingId: string;
    deviceId: string;
    name: string;
    source: "mesh" | "known";
  } {
    const installation = this.getSigningInstallationOptions().find(
      (candidate) => candidate.bindingId === bindingId,
    );
    if (!installation) {
      throw new Error("Select a configured device or Known device.");
    }
    return installation;
  }

  private applyProtectedData(protectedData: TephrameshProtectedData, recipient: string): void {
    const protectedCopy = structuredClone(protectedData);
    const {
      globalIgnoreRules: _legacyGlobalIgnoreRules,
      shardEncryptionKeyHash: _legacyShardEncryptionKeyHash,
      ...storedSettings
    } = protectedCopy.settings as TephrameshProtectedData["settings"] & {
      globalIgnoreRules?: unknown;
      shardEncryptionKeyHash?: unknown;
    };
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...storedSettings,
      ageRecipient: recipient,
      instances: normalizeInstanceDisplayOrder(protectedCopy.settings.instances),
      schemaVersion: 3,
    };
    if (!Object.prototype.hasOwnProperty.call(protectedCopy.settings, "noteSyncRequiredHosts")) {
      this.settings.noteSyncRequiredHosts = Math.max(
        1,
        this.settings.instances.filter((instance) => instance.kind === "shard").length + 1,
      );
    }
    this.settings.managedIgnoreRules = this.settings.managedIgnoreRules.filter(
      (line) => !/^\/\/ always ignore .*from tephramesh\b/i.test(line.trim()),
    );
    this.secrets = {
      apiKeys: Object.fromEntries(
        Object.entries(protectedCopy.secrets.apiKeys ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      shardEncryptionKey: typeof protectedCopy.secrets.shardEncryptionKey === "string"
        ? protectedCopy.secrets.shardEncryptionKey
        : "",
    };
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
    // Reconciliation shares Electron's network stack with status polling.
    // Keep one request per host active at a time to avoid another burst path.
    const system = await client.getSystemStatus();
    const devices = await client.getDevices();
    const folders = await client.getFolders();
    const pendingDevices = await client.getPendingDevices();
    const pendingFolders = await client.getPendingFolders();
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

  private async inspectInstanceForReconciliationBounded(
    instance: MeshInstance,
  ): Promise<InstanceReconciliationSnapshot> {
    let check = this.reconciliationChecks.get(instance.id);
    if (!check) {
      check = this.inspectInstanceForReconciliation(instance).finally(() => {
        if (this.reconciliationChecks.get(instance.id) === check) {
          this.reconciliationChecks.delete(instance.id);
        }
      });
      this.reconciliationChecks.set(instance.id, check);
    }
    const timeoutMs = Math.max(1, this.settings.offlineTimeoutSeconds) * 1000;
    let timer: number | undefined;
    try {
      return await Promise.race([
        check,
        new Promise<InstanceReconciliationSnapshot>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(`Reconciliation check timed out after ${this.settings.offlineTimeoutSeconds} seconds`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }

  async refreshReconciliation(force = false): Promise<ReconciliationReport> {
    if (this.reconciliationInProgress) return this.reconciliationReport;
    if (
      this.signingTrust === "approval-required" ||
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
    // Keep the last completed inspection visible while the next one is running.
    // This avoids clearing the diagnostic just because the offline-timeout-bounded
    // checks have started; the completed result is replaced atomically below.
    this.reconciliationReport = {
      state: "checking",
      issues: this.reconciliationReport.issues,
      repairBlockedReasons: this.reconciliationReport.repairBlockedReasons,
    };
    this.settingTab?.refreshReconciliationReport();
    try {
      const activeInstances = activeMeshInstances(this.settings.instances);
      const settled = await Promise.allSettled(
        activeInstances.map((instance) => {
          const status = this.runtimeStatuses.get(instance.id);
          if (!isRuntimeStatusFresh(status, this.settings.offlineTimeoutSeconds)) {
            return Promise.reject(new Error(
              status?.error ?? `No successful status check in the last ${this.settings.offlineTimeoutSeconds} seconds`,
            ));
          }
          return this.inspectInstanceForReconciliationBounded(instance);
        }),
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

  async removeKnownDevice(deviceId: string): Promise<void> {
    this.settings.knownDevices = this.settings.knownDevices.filter(
      (known) => known.deviceId !== deviceId,
    );
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
      this.signingTrust === "approval-required" ||
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
          this.pendingNotePaths = pendingNotePathsForHostThreshold(
            neededByPeer,
            activeInstances.length,
            this.settings.noteSyncRequiredHosts,
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

  async updateInstancePullOrder(instance: MeshInstance, pullOrder: string): Promise<void> {
    const previous = instance.pullOrder;
    instance.pullOrder = pullOrder as MeshInstance["pullOrder"];
    const desired = instance.pullOrder ?? "random";
    await this.saveSettings();
    try {
      const apiKey = this.getApiKey(instance.id);
      if (!apiKey) throw new Error("API key unavailable");
      await new SyncthingClient(instance.endpoint, apiKey).updateFolderPullOrder(
        this.settings.folderId,
        desired,
      );
    } catch (error) {
      instance.pullOrder = previous;
      await this.saveSettings();
      throw error;
    }
  }

  async setInstanceDisplayOrder(instanceId: string, targetIndex: number): Promise<void> {
    const ordered = [...this.settings.instances].sort(
      (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
    );
    const currentIndex = ordered.findIndex((instance) => instance.id === instanceId);
    if (currentIndex < 0) return;
    const boundedIndex = Math.max(0, Math.min(Math.trunc(targetIndex), ordered.length - 1));
    if (currentIndex !== boundedIndex) {
      const [instance] = ordered.splice(currentIndex, 1);
      if (instance) ordered.splice(boundedIndex, 0, instance);
    }
    ordered.forEach((instance, order) => { instance.displayOrder = order; });
    this.settings.instances = ordered;
    await this.saveSettings();
  }

  async updateManagedIgnoreRules(lines: string[]): Promise<void> {
    const previous = this.settings.managedIgnoreRules;
    const normalized = lines
      .map((line) => line.replace(/\r/g, "").trimEnd())
      .filter((line) => !/^\/\/ always ignore .*from tephramesh\b/i.test(line.trim()))
      .filter((line) => line.length > 0);
    this.settings.managedIgnoreRules = normalized;
    await this.saveSettings();
    const results = await Promise.allSettled(activeMeshInstances(this.settings.instances).map(async (instance) => {
      const apiKey = this.getApiKey(instance.id);
      if (!apiKey) throw new Error("API key unavailable");
      const client = new SyncthingClient(instance.endpoint, apiKey);
      await client.ensureDefaultIgnoreRules(normalized);
      await client.ensureFolderIgnoreRules(this.settings.folderId, normalized);
    }));
    const failures = results.filter((result) => result.status === "rejected").length;
    if (failures > 0) {
      this.settings.managedIgnoreRules = previous;
      await this.saveSettings();
      throw new Error(`Global ignore rules could not be updated on ${failures} instance${failures === 1 ? "" : "s"}.`);
    }
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

  setKnownHealthy(instanceId: string, version: string, operatingSystem?: string): void {
    this.runtimeStatuses.set(instanceId, {
      checkedAt: Date.now(),
      ok: true,
      version,
      operatingSystem,
    });
  }

  async refreshStatuses(forceNameCheck = false): Promise<void> {
    if (
      this.signingTrust === "approval-required" ||
      !this.settings.onboardingComplete ||
      !this.secretsAreUnlocked()
    ) return;
    if (this.refreshInProgress) {
      if (forceNameCheck) this.forcedStatusRefreshPending = true;
      return;
    }
    const availabilityBefore = activeMeshInstances(this.settings.instances)
      .map((instance) => `${instance.id}:${isRuntimeStatusFresh(
        this.runtimeStatuses.get(instance.id),
        this.settings.offlineTimeoutSeconds,
      )}`)
      .join("|");
    this.refreshInProgress = true;
    try {
      const now = Date.now();
      const checkMetadata = forceNameCheck || now >= this.nextInstanceMetadataRefreshAt;
      if (checkMetadata) {
        this.nextInstanceMetadataRefreshAt = now + TephrameshPlugin.INSTANCE_METADATA_REFRESH_INTERVAL_MS;
      }
      const nameChanges = await Promise.all(
        this.settings.instances.map(async (instance) => {
          const timeoutMs = Math.max(1, this.settings.offlineTimeoutSeconds) * 1000;
          let timer: number | undefined;
          try {
            let check = this.instanceStatusChecks.get(instance.id);
            if (!check) {
              check = this.refreshInstanceStatus(instance, false, checkMetadata).finally(() => {
                if (this.instanceStatusChecks.get(instance.id) === check) {
                  this.instanceStatusChecks.delete(instance.id);
                }
              });
              this.instanceStatusChecks.set(instance.id, check);
            }
            return await Promise.race([
              check,
              new Promise<boolean>((_, reject) => {
                timer = window.setTimeout(
                  () => reject(new Error(`Status check timed out after ${this.settings.offlineTimeoutSeconds} seconds`)),
                  timeoutMs,
                );
              }),
            ]);
          } catch (error) {
            this.runtimeStatuses.set(instance.id, {
              checkedAt: Date.now(),
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          } finally {
            if (timer !== undefined) window.clearTimeout(timer);
          }
        }),
      );
      if (nameChanges.some(Boolean)) {
        await this.saveSettings();
        this.settingTab.rerenderIfVisible();
      }
    } finally {
      this.refreshInProgress = false;
      this.settingTab.refreshRuntimeStatuses(this.runtimeStatuses);
      const availabilityAfter = activeMeshInstances(this.settings.instances)
        .map((instance) => `${instance.id}:${isRuntimeStatusFresh(
          this.runtimeStatuses.get(instance.id),
          this.settings.offlineTimeoutSeconds,
        )}`)
        .join("|");
      void this.refreshReconciliation(availabilityBefore !== availabilityAfter);
      if (this.forcedStatusRefreshPending) {
        this.forcedStatusRefreshPending = false;
        void this.refreshStatuses(true);
      }
    }
  }

  async refreshInstanceStatus(
    instance: MeshInstance,
    render = true,
    checkMetadata = true,
  ): Promise<boolean> {
    let nameChanged = false;
    try {
      const apiKey = this.getApiKey(instance.id);
      if (!apiKey) throw new Error("API key is unavailable in the encrypted configuration");
      const client = new SyncthingClient(instance.endpoint, apiKey);
      // Obsidian's requestUrl uses Electron's shared Chromium network stack.
      // Keep each host to one request at a time so polling several instances
      // cannot create a large simultaneous socket burst.
      const connections = await client.getConnections();
      const initialFolderStatus = this.settings.folderId
        ? await client.getFolderStatus(this.settings.folderId).catch(() => undefined)
        : undefined;
      // Identity, version, device-name, and folder configuration change rarely.
      // Fetch them together on the five-minute metadata cadence instead of on
      // every runtime polling tick.
      const system = checkMetadata ? await client.getSystemStatus() : undefined;
      const version = checkMetadata ? await client.getVersion() : undefined;
      const devices = checkMetadata ? await client.getDevices() : undefined;
      const folderConfig = checkMetadata && instance.setupState !== "pending" && this.settings.folderId
        ? await client.getFolder(this.settings.folderId).catch(() => undefined)
        : undefined;
      const reportedPullOrder = folderConfig?.order;
      if (
        reportedPullOrder === "random" ||
        reportedPullOrder === "alphabetic" ||
        reportedPullOrder === "smallestFirst" ||
        reportedPullOrder === "largestFirst" ||
        reportedPullOrder === "oldestFirst" ||
        reportedPullOrder === "newestFirst"
      ) {
        instance.pullOrder = reportedPullOrder;
      }
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
      if (system && system.myID !== instance.deviceId) {
        throw new Error("API now reports a different Syncthing device ID");
      }
      if (devices && system) {
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
      const previous = this.runtimeStatuses.get(instance.id);
      this.runtimeStatuses.set(instance.id, {
        checkedAt,
        ok: true,
        version: version?.version ?? previous?.version,
        operatingSystem: version?.os ?? previous?.operatingSystem,
        deviceId: system?.myID ?? previous?.deviceId ?? instance.deviceId,
        folder,
        folderPaused: folderConfig ? Boolean(folderConfig.paused) : previous?.folderPaused,
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
