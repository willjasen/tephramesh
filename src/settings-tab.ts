import { App, ButtonComponent, PluginSettingTab, Setting, setIcon } from "obsidian";
import type TephrameshPlugin from "./main";
import { coherentOfflineTimeoutSeconds, type InstanceKind, type InstanceRuntimeStatus, type MeshInstance } from "./model";
import {
  endpointUrl,
  shortDeviceId,
  validateShardPassword,
} from "./security";
import {
  activeMeshInstances,
  canRemoveInstance,
  createMeshPlan,
  isSyncthingSyncState,
  isRuntimeStatusFresh,
  meshRuntimeStates,
  topologyHealthState,
} from "./topology";
import { InstanceModal } from "./instance-modal";
import { showTephrameshNotice } from "./notices";
import { RemoveInstanceModal } from "./remove-instance-modal";
import { AgeIdentityBackupModal } from "./age-identity-backup-modal";
import { generatePostQuantumAgeKeyPair } from "./secret-bundle";
import { syncProgress } from "./syncthing-progress";
import { formatTransferRate } from "./syncthing-traffic";
import { EditEndpointModal } from "./edit-endpoint-modal";
import { MeshNotReadyError } from "./mesh-errors";
import { DeleteConfigModal } from "./delete-config-modal";
import { formatDataSize, formatFileSize } from "./format";
import { operatingSystemPresentation } from "./platform";
import { RestoreConfigVersionModal } from "./restore-config-version-modal";
import { ResolveConfigConflictModal } from "./resolve-config-conflict-modal";
import { RemoveKnownDeviceModal } from "./remove-known-device-modal";
import { ApproveEnrollmentModal } from "./approve-enrollment-modal";

function formatFolderUpdatedAt(stateChanged: string | undefined): string {
  if (!stateChanged) return "unknown";
  const date = new Date(stateChanged);
  return Number.isNaN(date.getTime()) ? stateChanged : date.toLocaleString();
}

type SettingsSection = "instances" | "vault" | "config" | "auth" | "topology";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "topology", label: "Topology" },
  { id: "instances", label: "Instances" },
  { id: "vault", label: "Vault" },
  { id: "config", label: "Config" },
  { id: "auth", label: "Signing" },
];

export class TephrameshSettingTab extends PluginSettingTab {
  private statusElements = new Map<string, HTMLElement>();
  private versionElements = new Map<string, HTMLElement>();
  private operatingSystemElements = new Map<string, HTMLElement>();
  private pauseButtons = new Map<string, ButtonComponent>();
  private topologyElement?: HTMLElement;
  private topologyTabIndicator?: HTMLElement;
  private reconciliationElement?: HTMLElement;
  private activeSection: SettingsSection = "topology";
  private visible = false;
  private configRevealed = false;
  private selectedConfigVersion?: number;
  private signingSelectedInstanceId?: string;
  private generatedEnrollmentApproval?: string;
  private pendingApprovedInstallation?: {
    bindingId: string;
    deviceId: string;
    deviceName: string;
    source: "mesh" | "known";
    keyId: string;
  };

  constructor(app: App, private readonly plugin: TephrameshPlugin) {
    super(app, plugin);
  }

  display(): void {
    if (!this.visible) {
      this.visible = true;
      this.plugin.startStatusPolling();
    }
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.configRevealed = false;
    this.selectedConfigVersion = undefined;
    this.generatedEnrollmentApproval = undefined;
    this.pendingApprovedInstallation = undefined;
    this.plugin.stopStatusPolling();
  }

  rerenderIfVisible(): void {
    if (this.visible) this.render();
  }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("tephramesh-settings");
    this.statusElements.clear();
    this.versionElements.clear();
    this.operatingSystemElements.clear();
    this.pauseButtons.clear();
    this.topologyElement = undefined;
    this.topologyTabIndicator = undefined;
    this.reconciliationElement = undefined;
    containerEl.createEl("h1", { text: "Tephramesh" });

    if (!this.plugin.hasEncryptionConfigured()) {
      this.renderEncryptionSetup(containerEl);
      return;
    }
    if (!this.plugin.secretsAreUnlocked()) {
      this.renderEncryptionUnlock(containerEl);
      return;
    }
    const signedConflict = this.plugin.getSignedConfigConflict();
    if (signedConflict) {
      this.renderSignedConfigConflict(containerEl, signedConflict.revision);
      return;
    }
    if (!this.plugin.settings.onboardingComplete) {
      this.renderOnboarding(containerEl);
      return;
    }
    this.renderSectionTabs(containerEl);
  }

  private renderSignedConfigConflict(container: HTMLElement, revision: number): void {
    container.createEl("h2", { text: "Configuration conflict" });
    container.createEl("p", {
      text: `This installation and another enrolled installation independently signed revision ${revision}. The age identity is valid and both versions remain protected. Choose the currently synchronized configuration to promote it as a new signed revision, or make another change on the installation whose configuration you want to keep.`,
    });
    new Setting(container)
      .setName("Currently synchronized configuration")
      .setDesc("Accept the configuration that Syncthing most recently placed in data.json. Any journaled competing revision remains encrypted for future recovery.")
      .addButton((button) => button.setButtonText("Keep synchronized config").setWarning().onClick(() => {
        new ResolveConfigConflictModal(this.app, revision, async () => {
          await this.plugin.acceptSynchronizedConfigConflict();
          this.render();
          showTephrameshNotice("success", "Configuration conflict resolved", `Revision ${revision + 1} is now the latest signed configuration.`);
        }).open();
      }));
  }

  private renderEncryptionSetup(container: HTMLElement): void {
    container.createEl("h2", { text: "Tephramesh initial setup" });
    container.createEl("p", {
      text: "Generate a dedicated post-quantum age identity to protect the plugin configuration.",
    });
    new Setting(container)
      .setName("Generate post-quantum identity")
      .setDesc("Uses hybrid ML-KEM-768 and X25519 encryption.")
      .addButton((button) =>
        button.setButtonText("Generate and continue").setCta().onClick(async () => {
          button.setDisabled(true).setButtonText("Generating…");
          try {
            const keys = await generatePostQuantumAgeKeyPair();
            await this.plugin.configureEncryption(keys.recipient, keys.identity);
            new AgeIdentityBackupModal(this.app, keys.identity, () => {
              this.display();
              showTephrameshNotice(
                "success",
                "Encryption configured",
                "Tephramesh secrets will use post-quantum age encryption.",
              );
            }).open();
          } catch (error) {
            showTephrameshNotice(
              "error",
              "Identity generation failed",
              error instanceof Error ? error.message : String(error),
            );
            button.setDisabled(false).setButtonText("Generate and continue");
          }
        }),
      );
  }

  private renderEncryptionUnlock(container: HTMLElement): void {
    container.createEl("h2", { text: "Unlock Tephramesh" });
    container.createEl("p", {
      text: "This vault already contains an age-encrypted Tephramesh configuration and its public recipient. Enter the matching private identity once on this Obsidian installation.",
    });
    let identity = "";
    new Setting(container)
      .setName("Age private identity")
      .setDesc("Stored only in this app's Obsidian Keychain.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("AGE-SECRET-KEY-1…").onChange((value) => {
          identity = value.trim();
        });
      });
    new Setting(container).addButton((button) =>
      button.setButtonText("Unlock").setCta().onClick(async () => {
        button.setDisabled(true).setButtonText("Unlocking…");
        try {
          await this.plugin.unlockSecrets(identity);
          identity = "";
          this.display();
          showTephrameshNotice("success", "Tephramesh unlocked");
          const conflict = this.plugin.getSignedConfigConflict();
          if (conflict) {
            showTephrameshNotice(
              "warning",
              "Configuration conflict detected",
              `Revision ${conflict.revision} was created independently on another installation. No configuration was overwritten; choose which changes to keep before saving again.`,
            );
          }
        } catch (error) {
          showTephrameshNotice(
            "error",
            "Unlock failed",
            error instanceof Error ? error.message : String(error),
          );
          button.setDisabled(false).setButtonText("Unlock");
        }
      }),
    );
  }

  refreshRuntimeStatuses(statuses: ReadonlyMap<string, InstanceRuntimeStatus>): void {
    for (const [instanceId, element] of this.statusElements) {
      const status = statuses.get(instanceId);
      this.updateStatusElement(element, status);
    }
    for (const [instanceId, element] of this.versionElements) {
      this.updateVersionElement(element, statuses.get(instanceId));
    }
    for (const [instanceId, element] of this.operatingSystemElements) {
      this.updateOperatingSystemElement(element, statuses.get(instanceId));
    }
    for (const [instanceId, button] of this.pauseButtons) {
      this.updatePauseButton(button, statuses.get(instanceId));
    }
    this.updateTopology();
  }

  refreshReconciliationReport(): void {
    this.updateReconciliation();
  }

  private renderOnboarding(container: HTMLElement): void {
    container.createEl("h2", { text: "Connect the first device" });
    container.createEl("p", {
      text: "First setup is locked to localhost. Test verifies the API connection; Add creates the vault folder in Syncthing when needed.",
    });
    new Setting(container)
      .setName("Local Syncthing")
      .setDesc("The port may differ from the default 8384.")
      .addButton((button) =>
        button.setButtonText("Connect localhost").setCta().onClick(() => {
          new InstanceModal(
            this.app,
            true,
            "device",
            "",
            this.app.vault.getName(),
            async () => undefined,
            async (result, apiKey) => {
              await this.plugin.setApiKey(result.instance.id, apiKey);
              this.plugin.settings.instances = [result.instance];
              this.plugin.settings.primaryInstanceId = result.instance.id;
              this.plugin.settings.folderId = result.discoveredFolder?.id ?? "";
              this.plugin.settings.folderLabel =
                result.discoveredFolder?.label || "Obsidian vault";
              this.plugin.settings.onboardingComplete = true;
              // A restored pre-onboarding snapshot can be running inside an
              // already-signed configuration. In that case the signing root
              // and this installation's enrollment were loaded from the
              // signed envelope, so creating a second genesis enrollment
              // would fail after Syncthing has already been changed.
              if (this.plugin.getSigningEnvironmentStatus().rootKeyId) {
                await this.plugin.saveSettings();
              } else {
                await this.plugin.initializeSigningEnvironment(`mesh:${result.instance.id}`);
              }
              this.plugin.setKnownHealthy(result.instance.id, result.version, result.operatingSystem);
              this.display();
              await this.plugin.refreshStatuses();
              showTephrameshNotice("success", "First device connected");
            },
          ).open();
        }),
      );
  }

  private renderSectionTabs(container: HTMLElement): void {
    const enrollmentRequired =
      this.plugin.getSigningEnvironmentStatus().state === "approval-required";
    if (enrollmentRequired) this.activeSection = "auth";
    const tabs = container.createDiv({ cls: "tephramesh-tabs" });
    tabs.setAttribute("role", "tablist");
    const visibleSections = enrollmentRequired
      ? SETTINGS_SECTIONS.filter((section) => section.id === "auth")
      : SETTINGS_SECTIONS;
    for (const section of visibleSections) {
      const active = section.id === this.activeSection;
      const button = tabs.createEl("button", {
        cls: active ? "tephramesh-tab is-active" : "tephramesh-tab",
      });
      if (section.id === "topology") {
        this.topologyTabIndicator = button.createSpan({
          cls: "tephramesh-topology-indicator tephramesh-tab-indicator",
        });
      } else if (section.id === "auth") {
        const signingStatus = this.plugin.getSigningEnvironmentStatus();
        const hasPendingInstallation = Boolean(this.pendingApprovedInstallation) ||
          (signingStatus.state === "enrolled" &&
            this.plugin.getSigningInstallationOptions().length > 0);
        const allAccepted = signingStatus.state === "enrolled" &&
          signingStatus.enrolledCount > 0 &&
          signingStatus.acceptedCount === signingStatus.enrolledCount &&
          !hasPendingInstallation;
        const indicator = button.createSpan({
          cls: `tephramesh-topology-indicator tephramesh-tab-indicator${allAccepted ? "" : " is-warning"}`,
        });
        const acceptanceLabel = hasPendingInstallation
          ? "A device is pending configuration-signing enrollment"
          : signingStatus.state !== "enrolled"
          ? "This installation is not enrolled for configuration signing"
          : allAccepted
            ? `All ${signingStatus.enrolledCount} enrolled installations accepted signed revision ${signingStatus.revision}`
            : `${signingStatus.acceptedCount} of ${signingStatus.enrolledCount} enrolled installations accepted signed revision ${signingStatus.revision}`;
        indicator.setAttribute("title", acceptanceLabel);
        button.setAttribute("aria-label", `Signing. ${acceptanceLabel}`);
      }
      button.createSpan({ text: section.label });
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(active));
      button.addEventListener("click", () => {
        if (this.activeSection === section.id) return;
        if (this.activeSection === "config") {
          this.configRevealed = false;
          this.selectedConfigVersion = undefined;
        }
        this.activeSection = section.id;
        this.display();
      });
    }

    const sectionContainer = container.createDiv({ cls: "tephramesh-tab-content" });
    sectionContainer.setAttribute("role", "tabpanel");
    switch (this.activeSection) {
      case "instances":
        this.renderInstances(sectionContainer);
        break;
      case "vault":
        this.renderMesh(sectionContainer);
        break;
      case "config":
        this.renderConfig(sectionContainer);
        break;
      case "auth":
        this.renderAuth(sectionContainer);
        break;
      case "topology":
        this.renderTopology(sectionContainer);
        break;
    }
  }

  private renderMesh(container: HTMLElement): void {
    new Setting(container)
      .setName("Syncthing folder ID")
      .setDesc("Shared identity of this vault across every instance.")
      .addText((text) =>
        text.setValue(this.plugin.settings.folderId).setDisabled(true),
      );
    new Setting(container)
      .setName("Folder label")
      .setDesc("A human-readable label; paths remain local to each instance.")
      .addText((text) =>
        text.setValue(this.plugin.settings.folderLabel).onChange(async (value) => {
          this.plugin.settings.folderLabel = value.trim() || "Obsidian vault";
          await this.plugin.saveSettings();
          this.plugin.scheduleFolderLabelSync();
          this.updateTopology();
        }),
      );
    new Setting(container)
      .setName("Tephramesh ignore rules")
      .setDesc("Rules managed by Tephramesh and added to Syncthing defaults. Existing rules entered in Syncthing are preserved. One line per rule.")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.managedIgnoreRules
            .filter((line) => !/^\/\/ always ignore .*from tephramesh\b/i.test(line.trim()))
            .join("\n"))
          .onChange(() => {});
        text.inputEl.addEventListener("blur", (event) => {
          // A settings refresh can detach the input and emit blur without a
          // real focus change. Do not persist during that lifecycle event.
          if (!event.relatedTarget) return;
          void this.plugin.updateManagedIgnoreRules(text.getValue().split(/\r?\n/));
        });
      });
      new Setting(container)
      .setName("Status refresh interval")
      .setDesc("Seconds between Syncthing status checks.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("1", "1 second")
          .addOption("5", "5 seconds")
          .addOption("10", "10 seconds")
          .addOption("30", "30 seconds")
          .addOption("60", "1 minute")
          .setValue(String(this.plugin.settings.pollIntervalSeconds))
          .onChange(async (value) => {
            this.plugin.settings.pollIntervalSeconds = Number(value);
            this.plugin.settings.offlineTimeoutSeconds = coherentOfflineTimeoutSeconds(
              this.plugin.settings.offlineTimeoutSeconds,
              this.plugin.settings.pollIntervalSeconds,
            );
            await this.plugin.saveSettings();
            this.plugin.restartPolling();
            await this.plugin.refreshStatuses(true);
            this.render();
          }),
      );
    new Setting(container)
      .setName("Offline timeout")
      .setDesc("Seconds without a successful status check before a device or shard is considered offline.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("1", "1 second")
          .addOption("5", "5 seconds")
          .addOption("10", "10 seconds")
          .addOption("30", "30 seconds")
          .addOption("60", "1 minute")
          .setValue(String(this.plugin.settings.offlineTimeoutSeconds))
          .onChange(async (value) => {
            this.plugin.settings.offlineTimeoutSeconds = coherentOfflineTimeoutSeconds(
              Number(value),
              this.plugin.settings.pollIntervalSeconds,
            );
            await this.plugin.saveSettings();
            await this.plugin.refreshStatuses(true);
            this.render();
          }),
      );
    new Setting(container)
      .setName("Note sync icon refresh interval")
      .setDesc("Seconds between checks for notes that active mesh instances still need.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("1", "1 second")
          .addOption("5", "5 seconds")
          .addOption("10", "10 seconds")
          .addOption("30", "30 seconds")
          .addOption("60", "1 minute")
          .setValue(String(this.plugin.settings.noteSyncPollIntervalSeconds))
          .onChange(async (value) => {
            this.plugin.settings.noteSyncPollIntervalSeconds = Number(value);
            await this.plugin.saveSettings();
            this.plugin.restartNoteSyncPolling();
          }),
      );
    const hostCount = activeMeshInstances(this.plugin.settings.instances).length;
    const defaultRequiredHosts = Math.max(
      1,
      activeMeshInstances(this.plugin.settings.instances).filter((instance) => instance.kind === "shard").length + 1,
    );
    const requiredHosts = Math.max(
      1,
      Math.min(this.plugin.settings.noteSyncRequiredHosts || defaultRequiredHosts, hostCount || 1),
    );
    if (this.plugin.settings.noteSyncRequiredHosts !== requiredHosts) {
      this.plugin.settings.noteSyncRequiredHosts = requiredHosts;
      void this.plugin.saveSettings();
    }
    new Setting(container)
      .setName("Hosts required before sync icon clears")
      .setDesc("The note icon clears when the note is available on at least this many active devices or shards.")
      .addDropdown((dropdown) => {
        for (let count = 1; count <= Math.max(1, hostCount); count += 1) {
          dropdown.addOption(String(count), String(count));
        }
        dropdown.setValue(String(requiredHosts)).onChange(async (value) => {
          this.plugin.settings.noteSyncRequiredHosts = Math.min(Number(value), Math.max(1, activeMeshInstances(this.plugin.settings.instances).length));
          await this.plugin.saveSettings();
          this.plugin.restartNoteSyncPolling();
        });
      });
  }

  private renderConfig(container: HTMLElement): void {
    const history = this.plugin.getConfigHistory();
    const currentVersion = history[0]?.version;
    if (history.length === 0) {
      container.createEl("p", { text: "No saved config versions are available." });
      this.renderSavedConfigVersions(container);
      this.renderDeleteConfig(container);
      return;
    }
    const selectedVersion = this.selectedConfigVersion ?? currentVersion;
    const selectedBlock = history.find((block) => block.version === selectedVersion) ?? history[0]!;
    this.selectedConfigVersion = selectedBlock.version;
    new Setting(container)
      .setName("Config version")
      .setDesc("Select a saved version to view its decrypted configuration. Keep this screen private.")
      .addDropdown((dropdown) => {
        for (const block of history) {
          const savedAt = new Date(block.savedAt);
          const dateLabel = Number.isNaN(savedAt.getTime()) ? block.savedAt : savedAt.toLocaleString();
          dropdown.addOption(String(block.version), `✅ Version ${block.version}${block.version === currentVersion ? " · Current" : ""} · ${dateLabel}`);
        }
        dropdown.setValue(String(selectedBlock.version)).onChange((value) => {
          this.selectedConfigVersion = Number(value);
          this.configRevealed = true;
          this.render();
        });
      })
      .addButton((button) => {
        if (!this.configRevealed) {
          button.setButtonText("Display").onClick(() => {
            this.configRevealed = true;
            this.render();
          });
          return;
        }
        button.setButtonText("Restore").setWarning();
        button.setDisabled(selectedBlock.version === currentVersion);
        button.onClick(() => new RestoreConfigVersionModal(this.app, selectedBlock.version, async () => {
          await this.plugin.restoreConfigVersion(selectedBlock.version);
          this.selectedConfigVersion = undefined;
          this.configRevealed = false;
          this.display();
          showTephrameshNotice("success", "Config version restored", `Version ${selectedBlock.version} is now the running configuration and was saved as a new latest version.`);
        }).open());
      });

    if (!this.configRevealed) {
      this.renderSavedConfigVersions(container);
      this.renderDeleteConfig(container);
      return;
    }
    const config = selectedBlock.config ?? this.plugin.getDecryptedConfig();
    if (!config) {
      container.createEl("p", { text: "Unlock Tephramesh to view the decrypted configuration." });
      this.renderSavedConfigVersions(container);
      this.renderDeleteConfig(container);
      return;
    }
    container.createEl("h3", { text: selectedBlock ? `Decrypted config version ${selectedBlock.version}` : "Decrypted running config" });
    const pre = container.createEl("pre", { cls: "tephramesh-config-json" });
    pre.createEl("code").setText(JSON.stringify(config, null, 2));
    this.renderSavedConfigVersions(container);
    this.renderDeleteConfig(container);
  }

  private renderSavedConfigVersions(container: HTMLElement): void {
    new Setting(container)
      .setName("Saved config versions")
      .setDesc("Number of encrypted configuration versions to retain (1–10).")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "10";
        text.inputEl.step = "1";
        text.setValue(String(this.plugin.settings.configHistoryVersions));
        text.onChange(async (value) => {
          const count = Number(value);
          if (!Number.isInteger(count) || count < 1 || count > 10) return;
          this.plugin.settings.configHistoryVersions = count;
          await this.plugin.saveSettings();
        });
      });

    const fileSizeSetting = new Setting(container)
      .setName("Config file size")
      .setDesc("Calculating data.json size…");
    void this.plugin.getConfigFileSize()
      .then((bytes) => {
        if (!fileSizeSetting.settingEl.isConnected) return;
        fileSizeSetting.setDesc(
          bytes === undefined
            ? "data.json is not currently available."
            : `data.json is ${formatFileSize(bytes)} on disk.`,
        );
      })
      .catch(() => {
        if (fileSizeSetting.settingEl.isConnected) {
          fileSizeSetting.setDesc("data.json size is currently unavailable.");
        }
      });
  }

  private renderAuth(container: HTMLElement): void {
    const signingState = this.renderSigningEnvironment(container);
    if (signingState === "approval-required") {
      this.renderDeleteConfig(container);
    }
  }

  private renderSigningEnvironment(
    container: HTMLElement,
  ): "unsigned" | "approval-required" | "enrolled" {
    const status = this.plugin.getSigningEnvironmentStatus();
    const signingInstallations = this.plugin.getSigningInstallationOptions();
    const selectedId = signingInstallations.some(
      (installation) => installation.bindingId === this.signingSelectedInstanceId,
    )
      ? this.signingSelectedInstanceId!
      : signingInstallations[0]?.bindingId ?? "";
    this.signingSelectedInstanceId = selectedId;

    if (status.state === "unsigned") {
      container.createEl("p", {
        text: "This existing encrypted configuration remains compatible but is not yet signed. Initialize signing on exactly one existing Obsidian installation; every other installation must then request approval from an enrolled device.",
        cls: "tephramesh-config-warning",
      });
      new Setting(container)
        .setName("This installation")
        .setDesc("Bind this Obsidian installation to its configured Syncthing device. This does not depend on the endpoint hostname.")
        .addDropdown((dropdown) => {
          for (const installation of signingInstallations) {
            dropdown.addOption(
              installation.bindingId,
              `${installation.name} · ${shortDeviceId(installation.deviceId)}${installation.source === "known" ? " · Known" : ""}`,
            );
          }
          dropdown.setValue(selectedId).onChange((value) => {
            this.signingSelectedInstanceId = value;
          });
        })
        .addButton((button) => button
          .setButtonText("Initialize signing")
          .setWarning()
          .setDisabled(!selectedId)
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Initializing…");
            try {
              await this.plugin.initializeSigningEnvironment(
                this.signingSelectedInstanceId ?? selectedId,
              );
              this.render();
              showTephrameshNotice(
                "success",
                "Configuration signing initialized",
                "This installation is the enrollment root. Approve every other installation with a manual request code.",
              );
            } catch (error) {
              showTephrameshNotice(
                "error",
                "Signing initialization failed",
                error instanceof Error ? error.message : String(error),
              );
              button.setDisabled(false).setButtonText("Initialize signing");
            }
          }));
      return status.state;
    }

    if (status.state === "approval-required") {
      container.createEl("p", {
        text: "This signed configuration is readable, but this tephramesh device cannot change it until an already enrolled installation approves its signing key.",
        cls: "tephramesh-config-warning",
      });
      const eligibleInstallations = signingInstallations;
      const enrollmentSelectedId = eligibleInstallations.some(
        (installation) => installation.bindingId === this.signingSelectedInstanceId,
      )
        ? this.signingSelectedInstanceId!
        : eligibleInstallations[0]?.bindingId ?? "";
      this.signingSelectedInstanceId = enrollmentSelectedId;
      new Setting(container)
        .setName("This installation")
        .setDesc(status.pendingRequestCode
          ? "Generate a replacement signing key for this configured installation, then have an enrolled installation approve it."
          : "Choose the configured Syncthing device represented by this Obsidian installation.")
        .addDropdown((dropdown) => {
          for (const installation of eligibleInstallations) {
            dropdown.addOption(
              installation.bindingId,
              `${installation.name} · ${shortDeviceId(installation.deviceId)}${installation.source === "known" ? " · Known" : ""}`,
            );
          }
          dropdown.setValue(enrollmentSelectedId).onChange((value) => {
            this.signingSelectedInstanceId = value;
          });
        })
        .addButton((button) => button
          .setButtonText(status.pendingRequestCode ? "Regenerate request" : "Generate request")
          .setDisabled(!enrollmentSelectedId)
          .onClick(async () => {
            try {
              const code = await this.plugin.generateEnrollmentRequest(
                this.signingSelectedInstanceId ?? enrollmentSelectedId,
              );
              await navigator.clipboard.writeText(code);
              this.render();
              showTephrameshNotice(
                "success",
                "Enrollment request copied",
                "Paste it into an enrolled installation's Approve request field.",
              );
            } catch (error) {
              showTephrameshNotice(
                "error",
                "Request generation failed",
                error instanceof Error ? error.message : String(error),
              );
            }
          }));
      container.createEl("h3", { text: "Already enrolled installations" });
      container.createEl("p", {
        text: "Send the enrollment request to one of these installations for approval.",
        cls: "setting-item-description",
      });
      const enrolledList = container.createDiv({
        cls: "tephramesh-authenticated-list",
      });
      if (status.pendingInstallation) {
        const pending = status.pendingInstallation;
        const pendingSetting = new Setting(enrolledList)
          .setName(pending.name)
          .setDesc(
            `Device ${shortDeviceId(pending.deviceId)} · Key ${pending.keyId.slice(0, 12)} · Waiting for an enrolled installation to approve this request`,
          );
        pendingSetting.settingEl.addClass(
          "tephramesh-authenticated-installation",
          "is-pending",
        );
        pendingSetting.nameEl.empty();
        pendingSetting.nameEl.createSpan({
          text: "Pending approval",
          cls: "tephramesh-authenticated-role is-pending",
        });
        pendingSetting.nameEl.appendText(` ${pending.name}`);
      }
      for (const installation of status.authenticatedInstallations) {
        const sourceLabel = installation.source === "mesh"
          ? "Device"
          : installation.source === "known"
            ? "Known"
            : "No longer configured";
        const enrolledSetting = new Setting(enrolledList)
          .setName(installation.name)
          .setDesc(
            `${sourceLabel} · Device ${shortDeviceId(installation.deviceId)} · Key ${installation.keyId.slice(0, 12)}`,
          );
        enrolledSetting.settingEl.addClass(
          "tephramesh-authenticated-installation",
          `is-${installation.source}`,
        );
        enrolledSetting.nameEl.empty();
        enrolledSetting.nameEl.createSpan({
          text: sourceLabel,
          cls: `tephramesh-authenticated-role is-${installation.source}`,
        });
        enrolledSetting.nameEl.appendText(` ${installation.name}`);
        if (installation.isEnrollmentRoot) {
          enrolledSetting.nameEl.createSpan({
            text: "Root",
            cls: "tephramesh-authenticated-marker is-root",
          });
        }
      }
      if (status.pendingRequestCode) {
        new Setting(container)
          .setName("Enrollment request")
          .setDesc("Copy this request to an enrolled installation.")
          .addTextArea((text) => {
            text.setValue(status.pendingRequestCode!).setDisabled(true);
            text.inputEl.rows = 4;
          })
          .addButton((button) => button.setButtonText("Copy request").onClick(async () => {
            await navigator.clipboard.writeText(status.pendingRequestCode!);
            button.setButtonText("Copied");
          }));
        let approvalCode = "";
        new Setting(container)
          .setName("Enrollment approval")
          .setDesc("Paste the approval returned by the enrolled installation.")
          .addTextArea((text) => {
            text.inputEl.rows = 4;
            text.setPlaceholder("Paste approval code").onChange((value) => {
              approvalCode = value.trim();
            });
          })
          .addButton((button) => button.setButtonText("Complete enrollment").setCta().onClick(async () => {
            button.setDisabled(true).setButtonText("Verifying…");
            try {
              await this.plugin.completeEnrollment(approvalCode);
              this.render();
              showTephrameshNotice(
                "success",
                "Installation enrolled",
                "This installation can now verify and sign Tephramesh configuration updates.",
              );
            } catch (error) {
              showTephrameshNotice(
                "error",
                "Enrollment failed",
                error instanceof Error ? error.message : String(error),
              );
              button.setDisabled(false).setButtonText("Complete enrollment");
            }
          }))
          .addButton((button) => button.setButtonText("Apply cancellation").setWarning().onClick(async () => {
            button.setDisabled(true).setButtonText("Verifying…");
            try {
              await this.plugin.applyEnrollmentCancellation(approvalCode);
              this.render();
              showTephrameshNotice(
                "success",
                "Enrollment request cancelled",
                "This installation can generate a new request when needed.",
              );
            } catch (error) {
              showTephrameshNotice(
                "error",
                "Cancellation failed",
                error instanceof Error ? error.message : String(error),
              );
              button.setDisabled(false).setButtonText("Apply cancellation");
            }
          }));
      }
      return status.state;
    }

    container.createEl("p", {
      text: `Enrolled as ${status.localInstallationName ?? "this installation"}`,
      cls: "tephramesh-enrolled-status",
    });
    new Setting(container)
      .setName(`Accepted by ${status.acceptedCount} of ${status.enrolledCount}`)
      .setDesc(`Signed configuration revision ${status.revision}. Each count is backed by a verified acknowledgement from that enrolled installation.`)
      .addButton((button) => button.setButtonText("Refresh").onClick(async () => {
        button.setDisabled(true).setButtonText("Refreshing…");
        try {
          await this.plugin.refreshConfigAcceptanceStatus();
        } catch (error) {
          showTephrameshNotice(
            "error",
            "Acceptance refresh failed",
            error instanceof Error ? error.message : String(error),
          );
          button.setDisabled(false).setButtonText("Refresh");
        }
      }));
    const authenticatedList = container.createDiv({
      cls: "tephramesh-authenticated-list",
    });
    if (this.pendingApprovedInstallation && status.authenticatedInstallations.some(
      (installation) => installation.keyId === this.pendingApprovedInstallation!.keyId,
    )) {
      this.pendingApprovedInstallation = undefined;
      this.generatedEnrollmentApproval = undefined;
    }
    if (this.pendingApprovedInstallation) {
      const pending = this.pendingApprovedInstallation;
      const pendingSetting = new Setting(authenticatedList)
        .setName(pending.deviceName)
        .setDesc(
          `Device ${shortDeviceId(pending.deviceId)} · Key ${pending.keyId.slice(0, 12)} · Waiting for this installation to complete enrollment`,
        )
        .addButton((button) => button
          .setButtonText("Copy approval")
          .setCta()
          .onClick(async () => {
            if (!this.generatedEnrollmentApproval) return;
            await navigator.clipboard.writeText(this.generatedEnrollmentApproval);
            button.setButtonText("Copied");
          }));
      pendingSetting.settingEl.addClass(
        "tephramesh-authenticated-installation",
        "is-pending",
      );
      pendingSetting.nameEl.empty();
      pendingSetting.nameEl.createSpan({
        text: "Pending approval",
        cls: "tephramesh-authenticated-role is-pending",
      });
      pendingSetting.nameEl.appendText(` ${pending.deviceName}`);
    }
    const awaitingInstallations = this.plugin.getSigningInstallationOptions().filter(
      (installation) =>
        !this.pendingApprovedInstallation ||
        (installation.bindingId !== this.pendingApprovedInstallation.bindingId &&
          installation.deviceId !== this.pendingApprovedInstallation.deviceId),
    );
    for (const installation of awaitingInstallations) {
      const role = installation.source === "mesh" ? "Device" : "Known";
      const awaitingSetting = new Setting(authenticatedList)
        .setName(installation.name)
        .setDesc(
          `${role} · Device ${shortDeviceId(installation.deviceId)} · Awaiting enrollment request`,
        );
      awaitingSetting.settingEl.addClass(
        "tephramesh-authenticated-installation",
        "is-pending",
      );
      awaitingSetting.nameEl.empty();
      awaitingSetting.nameEl.createSpan({
        text: "Awaiting request",
        cls: "tephramesh-authenticated-role is-pending",
      });
      awaitingSetting.nameEl.appendText(` ${installation.name}`);
    }
    const orderedInstallations = [...status.authenticatedInstallations].sort((a, b) => {
      const aOrder = this.plugin.settings.instances.find((instance) => instance.deviceId === a.deviceId)?.displayOrder;
      const bOrder = this.plugin.settings.instances.find((instance) => instance.deviceId === b.deviceId)?.displayOrder;
      if (aOrder === undefined && bOrder === undefined) return 0;
      if (aOrder === undefined) return 1;
      if (bOrder === undefined) return -1;
      return aOrder - bOrder;
    });
    orderedInstallations.forEach((installation, installationIndex) => {
      const role = installation.source === "mesh"
        ? "Device"
        : installation.source === "known"
          ? "Known"
          : "No longer configured";
      const approvedBy = installation.isEnrollmentRoot
        ? "Enrollment root"
        : `Approved by ${installation.approvedByName ?? "an enrolled installation"}`;
      const authenticatedAt = new Date(installation.createdAt);
      const authenticatedLabel = Number.isNaN(authenticatedAt.getTime())
        ? installation.createdAt
        : authenticatedAt.toLocaleString();
      const authenticatedSetting = new Setting(authenticatedList)
        .setName(installation.name)
        .setDesc(
          `Device ${shortDeviceId(installation.deviceId)} · Key ${installation.keyId.slice(0, 12)} · ${approvedBy} · ${authenticatedLabel} · ${installation.acceptedCurrentConfig ? "Accepted current config" : "Waiting for acknowledgement"}`,
        );
      authenticatedSetting.settingEl.addClass(
        "tephramesh-authenticated-installation",
        `is-${installation.source}`,
      );
      if (installation.isLocal) {
        authenticatedSetting.settingEl.addClass("is-local");
      }
      authenticatedSetting.nameEl.empty();
      const dragHandle = document.createElement("span");
      dragHandle.className = "tephramesh-instance-drag-handle";
      dragHandle.setAttribute("role", "button");
      dragHandle.setAttribute("tabindex", "0");
      dragHandle.setAttribute("aria-label", `Drag to reorder ${installation.name}`);
      dragHandle.setAttribute("draggable", "true");
      setIcon(dragHandle, "grip-vertical");
      authenticatedSetting.settingEl.addEventListener("dragover", (event) => {
        event.preventDefault();
        authenticatedSetting.settingEl.addClass("is-drag-over");
      });
      authenticatedSetting.settingEl.addEventListener("dragleave", () => authenticatedSetting.settingEl.removeClass("is-drag-over"));
      authenticatedSetting.settingEl.addEventListener("drop", async (event) => {
        event.preventDefault();
        authenticatedSetting.settingEl.removeClass("is-drag-over");
        const sourceId = event.dataTransfer?.getData("text/plain");
        const source = this.plugin.settings.instances.find((instance) => instance.deviceId === sourceId && instance.kind === "device");
        const target = this.plugin.settings.instances.find((instance) => instance.deviceId === installation.deviceId && instance.kind === "device");
        if (!source || !target || sourceId === installation.deviceId) return;
        await this.plugin.setInstanceDisplayOrder(source.id, installationIndex);
        this.display();
      });
      dragHandle.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("text/plain", installation.deviceId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        authenticatedSetting.settingEl.addClass("is-dragging");
      });
      dragHandle.addEventListener("dragend", () => {
        authenticatedSetting.settingEl.removeClass("is-dragging");
        authenticatedList.querySelectorAll(".is-drag-over").forEach((element) => element.removeClass("is-drag-over"));
      });
      authenticatedSetting.nameEl.prepend(dragHandle);
      authenticatedSetting.nameEl.createSpan({
        text: role,
        cls: `tephramesh-authenticated-role is-${installation.source}`,
      });
      authenticatedSetting.nameEl.appendText(` ${installation.name}`);
      if (installation.isLocal) {
        authenticatedSetting.nameEl.createSpan({
          text: "This installation",
          cls: "tephramesh-authenticated-marker is-local",
        });
      }
      if (installation.isEnrollmentRoot) {
        authenticatedSetting.nameEl.createSpan({
          text: "Root",
          cls: "tephramesh-authenticated-marker is-root",
        });
      }
      if (!installation.acceptedCurrentConfig) {
        authenticatedSetting.nameEl.createSpan({
          text: "Waiting",
          cls: "tephramesh-authenticated-marker is-waiting",
        });
      }
    });
    new Setting(container)
      .setName("Approve another installation")
      .setDesc("Paste the request generated on the other installation. Review its device and key before approving it.")
      .addButton((button) => button.setButtonText("Open approval window").setCta().onClick(() => {
        new ApproveEnrollmentModal(
          this.app,
          this.plugin,
          (approval, installation) => {
            this.generatedEnrollmentApproval = approval;
            this.pendingApprovedInstallation = installation;
            this.render();
          },
          (_cancellation, installation) => {
            if (this.pendingApprovedInstallation?.deviceId === installation.deviceId) {
              this.generatedEnrollmentApproval = undefined;
              this.pendingApprovedInstallation = undefined;
            }
            this.render();
          },
        ).open();
      }));
    return status.state;
  }

  private renderDeleteConfig(container: HTMLElement): void {
    const signingStatus = this.plugin.getSigningEnvironmentStatus();
    if (signingStatus.state !== "enrolled" && !this.plugin.canDeleteConfigForRecovery()) return;
    new Setting(container)
      .setName("Delete Config")
      .setDesc(this.plugin.canDeleteConfigForRecovery()
        ? "Reset Tephramesh after all configuration-signing keys were lost."
        : "Erase Tephramesh's encrypted plugin data for this vault.")
      .addButton((button) =>
        button.setButtonText("Delete Config").setWarning().onClick(() => {
          new DeleteConfigModal(this.app, async () => {
            await this.plugin.deleteConfig();
            this.display();
            showTephrameshNotice(
              "success",
              "Config deleted",
              "Tephramesh is ready for initial setup. Syncthing and vault files were not changed.",
            );
          }).open();
        }),
      );
  }

  private renderInstances(container: HTMLElement): void {
    const orderedInstances = [...this.plugin.settings.instances].sort(
      (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
    );
    const instanceGroups: Array<{ kind: InstanceKind; label: string }> = [
      { kind: "device", label: "Devices" },
      { kind: "shard", label: "Shards" },
    ];
    let hasRenderedSection = false;
    for (const group of instanceGroups) {
      const instances = orderedInstances.filter((instance) => instance.kind === group.kind);
      if (group.kind === "shard" || instances.length > 0) {
        const section = container.createDiv({ cls: "tephramesh-instance-section" });
        if (hasRenderedSection) section.addClass("has-divider");
        hasRenderedSection = true;
        const sectionHeading = section.createDiv({ cls: "tephramesh-instance-section-heading" });
        sectionHeading.createEl("h3", { text: group.label });
        const addButton = sectionHeading.createEl("button", {
          text: `Add ${group.kind}`,
          cls: group.kind === "device" ? "mod-cta" : undefined,
        });
        addButton.addEventListener("click", () => this.openInstanceModal(group.kind));
        instances.forEach((instance) => {
        const index = orderedInstances.indexOf(instance);
        const setting = new Setting(section);
      setting.settingEl.addClass("tephramesh-instance-card");
      setting.settingEl.dataset.instanceId = instance.id;
      const dragHandle = document.createElement("span");
      dragHandle.className = "tephramesh-instance-drag-handle";
      dragHandle.setAttribute("role", "button");
      dragHandle.setAttribute("tabindex", "0");
      dragHandle.setAttribute("aria-label", `Drag to reorder ${instance.name}`);
      dragHandle.setAttribute("draggable", "true");
      setIcon(dragHandle, "grip-vertical");
      setting.settingEl.addEventListener("dragover", (event) => {
        event.preventDefault();
        setting.settingEl.addClass("is-drag-over");
      });
      setting.settingEl.addEventListener("dragleave", () => {
        setting.settingEl.removeClass("is-drag-over");
      });
      setting.settingEl.addEventListener("drop", async (event) => {
        event.preventDefault();
        setting.settingEl.removeClass("is-drag-over");
        const sourceId = event.dataTransfer?.getData("text/plain");
        if (!sourceId || sourceId === instance.id) return;
        await this.plugin.setInstanceDisplayOrder(sourceId, index);
        this.display();
      });
      dragHandle.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("text/plain", instance.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        setting.settingEl.addClass("is-dragging");
      });
      dragHandle.addEventListener("dragend", () => {
        setting.settingEl.removeClass("is-dragging");
        container.querySelectorAll(".is-drag-over").forEach((element) => element.removeClass("is-drag-over"));
      });
      setting.nameEl.empty();
      setting.nameEl.prepend(dragHandle);
      const instanceLink = setting.nameEl.createEl("a", {
        text: ` ${instance.name}`,
        href: endpointUrl(instance.endpoint),
        cls: "tephramesh-instance-name-link",
      });
      instanceLink.setAttribute("target", "_blank");
      instanceLink.setAttribute("rel", "noopener noreferrer");
      const operatingSystem = setting.nameEl.createSpan({
        cls: "tephramesh-instance-os",
      });
      this.operatingSystemElements.set(instance.id, operatingSystem);
      this.updateOperatingSystemElement(
        operatingSystem,
        this.plugin.runtimeStatuses.get(instance.id),
      );
      this.renderSigningBadge(setting.nameEl, instance.deviceId);
      setting.nameEl.createSpan({
        text: ` · ${shortDeviceId(instance.deviceId)}`,
        cls: "tephramesh-instance-heading-meta",
      });
      const version = setting.nameEl.createSpan({
        cls: "tephramesh-instance-heading-meta",
      });
      this.versionElements.set(instance.id, version);
      this.updateVersionElement(
        version,
        this.plugin.runtimeStatuses.get(instance.id),
      );
      setting.descEl.empty();
      setting.addDropdown((dropdown) => dropdown
        .addOption("random", "Random")
        .addOption("alphabetic", "Alphabetical")
        .addOption("smallestFirst", "Smallest first")
        .addOption("largestFirst", "Largest first")
        .addOption("oldestFirst", "Oldest first")
        .addOption("newestFirst", "Newest first")
        .setValue(instance.pullOrder ?? "random")
        .onChange(async (value) => {
          await this.plugin.updateInstancePullOrder(instance, value);
        }),
      );
      const status = setting.descEl.createDiv({ cls: "tephramesh-status" });
      if (instance.setupState === "pending") {
        status.addClass("is-pending");
        status.setText("pending setup · waiting for the active mesh to become ready");
        setting.addButton((button) => {
          button.buttonEl.addClass("tephramesh-pending-button");
          button.setButtonText("Pending setup").onClick(async () => {
            button.setDisabled(true).setButtonText("Checking…");
            try {
              await this.plugin.completePendingInstance(instance);
              this.display();
              showTephrameshNotice(
                "success",
                "Instance setup complete",
                `${instance.name} is now part of the mesh.`,
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              showTephrameshNotice(
                error instanceof MeshNotReadyError ? "warning" : "error",
                error instanceof MeshNotReadyError ? "Mesh not ready" : "Pending setup failed",
                message,
              );
              button.setDisabled(false).setButtonText("Pending setup");
            }
          });
        });
      } else {
        this.statusElements.set(instance.id, status);
        this.updateStatusElement(status, this.plugin.runtimeStatuses.get(instance.id));
        setting.addButton((button) => {
          this.pauseButtons.set(instance.id, button);
          this.updatePauseButton(
            button,
            this.plugin.runtimeStatuses.get(instance.id),
          );
          button.onClick(async () => {
            const paused = Boolean(
              this.plugin.runtimeStatuses.get(instance.id)?.folderPaused,
            );
            button.setDisabled(true);
            try {
              await this.plugin.setInstanceFolderPaused(instance, !paused);
              showTephrameshNotice(
                "success",
                paused ? "Folder resumed" : "Folder paused",
                `${instance.name}'s managed folder is now ${paused ? "active" : "paused"}.`,
              );
            } catch (error) {
              showTephrameshNotice(
                "error",
                paused ? "Resume failed" : "Pause failed",
                error instanceof Error ? error.message : String(error),
              );
            } finally {
              this.updatePauseButton(
                button,
                this.plugin.runtimeStatuses.get(instance.id),
              );
            }
          });
        });
      }
      setting.addButton((button) =>
        button.setIcon("pencil").setTooltip("Edit Syncthing URL").onClick(() => {
          const apiKey = this.plugin.getApiKey(instance.id);
          if (!apiKey) {
            showTephrameshNotice(
              "error",
              "API key unavailable",
              "Unlock the encrypted plugin configuration before editing this URL.",
            );
            return;
          }
          new EditEndpointModal(this.app, instance, apiKey, async (endpoint) => {
            instance.endpoint = endpoint;
            await this.plugin.saveSettings();
            this.display();
            await this.plugin.refreshInstanceStatus(instance);
          }).open();
        }),
      );
      if (canRemoveInstance(this.plugin.settings.instances, instance)) {
        setting.addButton((button) =>
          button
            .setIcon("trash-2")
            .setWarning()
            .setTooltip("Remove instance and Syncthing folder")
            .onClick(() => {
              new RemoveInstanceModal(this.app, instance, async () => {
                const wasPending = instance.setupState === "pending";
                await this.plugin.removeInstance(instance);
                this.display();
                showTephrameshNotice(
                  "success",
                  "Instance removed",
                  wasPending
                    ? `${instance.name} was forgotten. Any partially created managed folder was removed; files on disk were preserved.`
                    : `The managed Syncthing folder was removed from ${instance.name}. Files on disk were preserved.`,
                );
              }).open();
            }),
        );
      }
        });
      }
    }
    if (this.plugin.settings.knownDevices.length > 0) {
      const knownSection = container.createDiv({ cls: "tephramesh-instance-section" });
      if (hasRenderedSection) knownSection.addClass("has-divider");
      knownSection.createEl("h3", { text: "Known", cls: "tephramesh-instance-section-heading" });
      for (const known of this.plugin.settings.knownDevices) {
      const setting = new Setting(knownSection);
      setting.settingEl.addClass("tephramesh-instance-card");
      setting.nameEl.empty();
      setting.nameEl.appendText(` ${known.name}`);
      setting.nameEl.createSpan({ text: ` · ${shortDeviceId(known.deviceId)}`, cls: "tephramesh-instance-heading-meta" });
      this.renderSigningBadge(setting.nameEl, known.deviceId);
      setting.addButton((button) =>
        button
          .setIcon("trash-2")
          .setWarning()
          .setTooltip("Remove Known device")
          .onClick(() => {
            new RemoveKnownDeviceModal(this.app, known, async () => {
              await this.plugin.removeKnownDevice(known.deviceId);
              this.display();
              showTephrameshNotice(
                "success",
                "Known device removed",
                `${known.name} is no longer preserved by mesh repair. Syncthing configuration and files were not changed.`,
              );
            }).open();
          }),
      );
      }
    }
  }

  private renderSigningBadge(container: HTMLElement, deviceId: string): void {
    const state = this.plugin.getSigningStatusForDevice(deviceId);
    if (state === "unsigned") return;
    const badge = container.createSpan({
      cls: `tephramesh-signing-badge is-${state}`,
      text: state === "signed" ? "Signed" : "Pending signing",
    });
    badge.setAttribute(
      "aria-label",
      state === "signed"
        ? "This installation is enrolled for configuration signing."
        : "This installation has a pending configuration-signing enrollment request.",
    );
    badge.setAttribute("title", badge.getAttribute("aria-label")!);
  }

  private openInstanceModal(kind: InstanceKind): void {
    if (kind === "shard") {
      const password = this.plugin.getShardEncryptionKey();
      if (!password || validateShardPassword(password)) {
        showTephrameshNotice(
          "warning",
          "Shard encryption key required",
          "Create or select a valid shard encryption key before adding a shard.",
        );
        return;
      }
    }
    new InstanceModal(
      this.app,
      false,
      kind,
      this.plugin.settings.folderId,
      this.plugin.settings.folderLabel,
      async (result) => {
        if (
          this.plugin.settings.instances.some(
            (instance) => instance.deviceId === result.instance.deviceId,
          )
        ) {
          throw new Error("That Syncthing device is already in this mesh.");
        }
        await this.plugin.assertMeshReadyForInstanceAdd();
      },
      async (result, apiKey) => {
        await this.plugin.setApiKey(result.instance.id, apiKey);
        try {
          await this.plugin.reconcileNewInstance(result.instance);
        } catch (error) {
          await this.plugin.removeApiKey(result.instance.id);
          throw error;
        }
        this.plugin.settings.instances.push(result.instance);
        await this.plugin.saveSettings();
        this.plugin.setKnownHealthy(result.instance.id, result.version, result.operatingSystem);
        this.display();
        await this.plugin.refreshStatuses();
      },
      async (result, apiKey) => {
        await this.plugin.savePendingInstance(result.instance, apiKey);
        this.plugin.setKnownHealthy(result.instance.id, result.version, result.operatingSystem);
        this.display();
      },
    ).open();
  }

  private renderTopology(container: HTMLElement): void {
    this.topologyElement = container.createDiv({ cls: "tephramesh-topology" });
    this.updateTopology();
    this.reconciliationElement = container.createDiv({
      cls: "tephramesh-reconciliation",
    });
    this.updateReconciliation();
    void this.plugin.refreshReconciliation();
  }

  private updateReconciliation(): void {
    if (!this.reconciliationElement) return;
    const container = this.reconciliationElement;
    container.empty();
    const report = this.plugin.reconciliationReport;
    for (const state of [
      "checking",
      "healthy",
      "issues",
      "unavailable",
      "repairing",
    ]) {
      container.toggleClass(`is-${state}`, state === report.state);
    }

    const setting = new Setting(container).setName("Automatic reconciliation");
    const summary = {
      checking: "Checking every active instance…",
      healthy: "No mesh configuration issues found.",
      issues: `${report.issues.length} mesh configuration issue${report.issues.length === 1 ? "" : "s"} found.`,
      unavailable: "The complete mesh could not be inspected.",
      repairing: "Applying and verifying mesh repairs…",
    }[report.state];
    setting.setDesc(summary);
    setting.addButton((button) =>
      button
        .setIcon("search")
        .setTooltip("Check mesh configuration now")
        .setDisabled(report.state === "checking" || report.state === "repairing")
        .onClick(async () => {
          button.setDisabled(true);
          await this.plugin.refreshReconciliation(true);
        }),
    );

    const hasUnsafeIssue = report.issues.some((issue) => !issue.repairable);
    const canRepair =
      report.state === "issues" &&
      !hasUnsafeIssue &&
      report.repairBlockedReasons.length === 0;
    setting.addButton((button) =>
      button
        .setButtonText(report.state === "repairing" ? "Repairing…" : "Repair mesh")
        .setCta()
        .setDisabled(!canRepair)
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Repairing…");
          try {
            await this.plugin.repairMesh();
            showTephrameshNotice(
              "success",
              "Mesh repaired",
              "Every repair was verified against Syncthing.",
            );
          } catch (error) {
            showTephrameshNotice(
              error instanceof MeshNotReadyError ? "warning" : "error",
              error instanceof MeshNotReadyError
                ? "Mesh not ready for repair"
                : "Mesh repair incomplete",
              error instanceof Error ? error.message : String(error),
            );
            await this.plugin.refreshReconciliation(true);
          }
        }),
    );

    if (report.issues.length > 0) {
      const list = container.createEl("ul", {
        cls: "tephramesh-reconciliation-issues",
      });
      for (const currentIssue of report.issues) {
        const item = list.createEl("li", {
          text: `${currentIssue.instanceName}: ${currentIssue.message}`,
          cls: currentIssue.repairable ? "is-repairable" : "is-blocking",
        });
        if (currentIssue.deviceId) {
          const button = item.createEl("button", { text: "Add as Known", cls: "tephramesh-known-button" });
          button.addEventListener("click", async () => {
            button.disabled = true;
            await this.plugin.addKnownDevice(currentIssue.deviceId!, currentIssue.deviceName ?? "Known device");
          });
        }
      }
    }
    if (report.repairBlockedReasons.length > 0) {
      container.createDiv({
        cls: "tephramesh-reconciliation-blocked",
        text: `Repair is waiting: ${report.repairBlockedReasons.join(" ")}`,
      });
    } else if (hasUnsafeIssue) {
      container.createDiv({
        cls: "tephramesh-reconciliation-blocked",
        text: "Repair is blocked until the unsafe configuration is corrected manually.",
      });
    }
  }

  private updateTopology(): void {
    if (!this.topologyElement) return;
    this.topologyElement.empty();
    this.topologyElement.removeClass("is-valid", "is-incomplete", "is-warning");
    try {
      createMeshPlan(
        this.plugin.settings.instances,
        this.plugin.settings.folderId,
        this.plugin.settings.folderLabel,
        this.plugin.getShardEncryptionKey() ?? "",
      );
      const activeInstances = activeMeshInstances(this.plugin.settings.instances);
      const operatingInstances = activeInstances.filter(
        (instance) => isRuntimeStatusFresh(
          this.plugin.runtimeStatuses.get(instance.id),
          this.plugin.settings.offlineTimeoutSeconds,
        ),
      );
      const metricsFor = (instances: MeshInstance[]) => {
        const devices = instances.filter((item) => item.kind === "device").length;
        const count = instances.length;
        const reportedGlobalFiles = instances.flatMap((instance) => {
          const value = this.plugin.runtimeStatuses.get(instance.id)?.folder?.globalFiles;
          return typeof value === "number" && Number.isFinite(value) ? [value] : [];
        });
        const reportedGlobalBytes = instances.flatMap((instance) => {
          const value = this.plugin.runtimeStatuses.get(instance.id)?.folder?.globalBytes;
          return typeof value === "number" && Number.isFinite(value) ? [value] : [];
        });
        return {
          devices,
          shards: count - devices,
          connections: (count * (count - 1)) / 2,
          globalFiles: reportedGlobalFiles.length > 0 ? Math.max(...reportedGlobalFiles) : undefined,
          globalBytes: reportedGlobalBytes.length > 0 ? Math.max(...reportedGlobalBytes) : undefined,
        };
      };
      const configured = metricsFor(activeInstances);
      const operating = metricsFor(operatingInstances);
      const healthState = topologyHealthState(activeInstances, operatingInstances);
      this.topologyElement.addClass("is-valid");
      if (healthState === "warning") this.topologyElement.addClass("is-warning");
      this.topologyTabIndicator?.classList.remove("is-warning", "is-incomplete");
      this.topologyTabIndicator?.addClass(`is-${healthState}`);

      const operatingSection = this.topologyElement.createDiv({ cls: "tephramesh-topology-section tephramesh-topology-operating" });
      const operatingHeading = operatingSection.createDiv({ cls: "tephramesh-topology-heading" });
      const operatingTitle = operatingHeading.createDiv({ cls: "tephramesh-topology-title" });
      operatingTitle.createEl("h3", { text: "Operating now" });
      const runtimeGroup = operatingTitle.createDiv({ cls: "tephramesh-topology-runtime-group" });
      const status = operatingHeading.createDiv({
        cls: "tephramesh-topology-status",
      });
      status.createSpan({ cls: `tephramesh-topology-indicator is-${healthState}` });
      const statusText = status.createDiv();
      statusText.createEl("strong", { text: healthState === "healthy" ? "Healthy" : "Warning" });
      for (const runtimeState of meshRuntimeStates(
        this.plugin.settings.instances,
        this.plugin.runtimeStatuses,
        this.plugin.settings.offlineTimeoutSeconds,
      )) {
        if (runtimeState === "unavailable") continue;
        const runtimeBadge = runtimeGroup.createSpan({
          cls: `tephramesh-topology-runtime is-${runtimeState}`,
          text: runtimeState,
        });
      }
      const operatingMetrics = operatingSection.createDiv({ cls: "tephramesh-topology-metrics" });
      const globalSize = formatDataSize(operating.globalBytes) ?? "—";
      for (const { label, value, role, online } of [
        {
          label: operating.devices === 1 ? "Device" : "Devices",
          value: operating.devices,
          role: "devices",
          online: configured.devices > 0 && operating.devices === configured.devices,
        },
        {
          label: operating.shards === 1 ? "Shard" : "Shards",
          value: operating.shards,
          role: "shards",
          online: configured.shards > 0 && operating.shards === configured.shards,
        },
        { label: operating.connections === 1 ? "Connection" : "Connections", value: operating.connections, role: undefined, online: undefined },
        { label: "Global files", value: operating.globalFiles ?? "—", role: undefined, online: undefined },
        { label: "Global size", value: globalSize, role: undefined, online: undefined },
      ]) {
        const metric = operatingMetrics.createDiv({
          cls: `tephramesh-topology-metric${role ? ` is-${online ? "online" : "offline"}` : ""}`,
        });
        metric.createEl("strong", { text: String(value) });
        metric.createSpan({ text: label });
      }

      const configuredSection = this.topologyElement.createDiv({ cls: "tephramesh-topology-section" });
      configuredSection.createEl("h3", { text: "Configured" });
      const metrics = configuredSection.createDiv({ cls: "tephramesh-topology-metrics" });
      for (const [label, value] of [
        [configured.devices === 1 ? "Device" : "Devices", configured.devices],
        [configured.shards === 1 ? "Shard" : "Shards", configured.shards],
        [configured.connections === 1 ? "Connection" : "Connections", configured.connections],
      ] as const) {
        const metric = metrics.createDiv({ cls: "tephramesh-topology-metric" });
        metric.createEl("strong", { text: String(value) });
        metric.createSpan({ text: label });
      }

      const details = this.topologyElement.createDiv({
        cls: "tephramesh-topology-details",
      });
      const trusted = details.createDiv({ cls: "tephramesh-topology-detail" });
      trusted.createEl("strong", { text: "Devices" });
      trusted.createSpan({ text: "Send & Receive · plaintext at rest" });
      const encrypted = details.createDiv({ cls: "tephramesh-topology-detail" });
      encrypted.createEl("strong", { text: "Shards" });
      encrypted.createSpan({ text: "Receive Encrypted · ciphertext at rest" });
    } catch (error) {
      this.topologyElement.addClass("is-incomplete");
      this.topologyTabIndicator?.classList.remove("is-warning", "is-healthy");
      this.topologyTabIndicator?.addClass("is-incomplete");
      const status = this.topologyElement.createDiv({
        cls: "tephramesh-topology-status",
      });
      status.createSpan({ cls: "tephramesh-topology-indicator" });
      const statusText = status.createDiv();
      statusText.createEl("strong", { text: "Plan incomplete" });
      statusText.createDiv({
        cls: "tephramesh-topology-subtitle",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private updateVersionElement(
    element: HTMLElement,
    status: InstanceRuntimeStatus | undefined,
  ): void {
    const version = isRuntimeStatusFresh(status, this.plugin.settings.offlineTimeoutSeconds) ? status?.version : undefined;
    element.setText(` · ${version ?? "—"}`);
  }

  private updateOperatingSystemElement(
    element: HTMLElement,
    status: InstanceRuntimeStatus | undefined,
  ): void {
    const fresh = isRuntimeStatusFresh(status, this.plugin.settings.offlineTimeoutSeconds);
    const presentation = fresh
      ? operatingSystemPresentation(status?.operatingSystem)
      : undefined;
    element.toggleClass("is-visible", Boolean(presentation));
    element.setText(presentation?.glyph ?? "");
    if (presentation) {
      element.setAttribute("aria-label", presentation.label);
      element.setAttribute("title", presentation.label);
    } else {
      element.removeAttribute("aria-label");
      element.removeAttribute("title");
    }
  }

  private updatePauseButton(
    button: ButtonComponent,
    status: InstanceRuntimeStatus | undefined,
  ): void {
    const fresh = isRuntimeStatusFresh(status, this.plugin.settings.offlineTimeoutSeconds);
    const paused = Boolean(fresh && status?.folderPaused);
    button
      .setIcon(paused ? "play" : "pause")
      .setTooltip(paused ? "Resume managed folder" : "Pause managed folder")
      .setDisabled(!fresh || !status?.folder);
  }

  private updateStatusElement(
    element: HTMLElement,
    status: InstanceRuntimeStatus | undefined,
  ): void {
    element.empty();
    element.removeClass("is-error", "is-scanning", "is-syncing", "is-paused");
    if (!status) {
      element.setText("Not checked yet");
      return;
    }
    if (!isRuntimeStatusFresh(status, this.plugin.settings.offlineTimeoutSeconds)) {
      if (status.ok) {
        element.setText(`Unavailable: no successful status check in the last ${this.plugin.settings.offlineTimeoutSeconds} seconds`);
      } else {
        element.setText(`Unavailable: ${status.error ?? "Unknown error"}`);
      }
      element.addClass("is-error");
      return;
    }
    if (!status.ok) {
      element.setText(`Unavailable: ${status.error ?? "Unknown error"}`);
      element.addClass("is-error");
      return;
    }
    if (!status.folder) {
      element.setText(`Connected · Syncthing ${status.version ?? "unknown"} · folder not configured here yet`);
      return;
    }
    const folder = status.folder;
    const pending = folder.needFiles ?? 0;
    const updated = `updated ${formatFolderUpdatedAt(folder.stateChanged)}`;
    if (status.folderPaused) {
      element.addClass("is-paused");
      element.createDiv({
        text: `paused · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files · ${pending} pending · ${updated}`,
      });
      this.renderPendingFiles(element, status.pendingFiles);
      return;
    }
    if (folder.state === "scanning") {
      element.addClass("is-scanning");
      const progress = folder.scanProgress;
      element.createDiv({
        text: `scanning · ${progress === undefined ? "calculating…" : `${progress}%`} · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files · ${updated}`,
      });
      this.renderPendingFiles(element, status.pendingFiles);
      return;
    }
    if (isSyncthingSyncState(folder.state)) {
      element.addClass("is-syncing");
    }
    if (folder.state === "syncing") {
      const progress = syncProgress(folder);
      element.createDiv({
        text: `syncing · ${progress === undefined ? "calculating…" : `${progress}%`} · ↓ ${formatTransferRate(status.downloadBytesPerSecond)} · ↑ ${formatTransferRate(status.uploadBytesPerSecond)} · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files · ${pending} pending · ${updated}`,
      });
      this.renderPendingFiles(element, status.pendingFiles);
      return;
    }
    element.createDiv({
      text: `${folder.state} · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files · ${pending} pending · ${updated}`,
    });
    this.renderPendingFiles(element, status.pendingFiles);
  }

  private renderPendingFiles(
    element: HTMLElement,
    pendingFiles: string[] | undefined,
  ): void {
    if (!pendingFiles?.length) return;
    element.createDiv({
      cls: "tephramesh-pending-files-label",
      text: "Pending files",
    });
    const list = element.createEl("ul", {
      cls: "tephramesh-pending-files",
      attr: { "aria-label": "Pending files" },
    });
    for (const path of pendingFiles) {
      list.createEl("li", { text: path });
    }
  }
}
