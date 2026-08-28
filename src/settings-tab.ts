import {
  App,
  ButtonComponent,
  PluginSettingTab,
  Setting,
} from "obsidian";
import type TephrameshPlugin from "./main";
import type { InstanceKind, InstanceRuntimeStatus, MeshInstance } from "./model";
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
  unavailableInstancesSummary,
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
import { formatDataSize } from "./format";
import { operatingSystemPresentation } from "./platform";

type SettingsSection = "instances" | "vault" | "config" | "topology";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "topology", label: "Topology" },
  { id: "instances", label: "Instances" },
  { id: "vault", label: "Vault" },
  { id: "config", label: "Config" },
];

export class TephrameshSettingTab extends PluginSettingTab {
  private statusElements = new Map<string, HTMLElement>();
  private versionElements = new Map<string, HTMLElement>();
  private operatingSystemElements = new Map<string, HTMLElement>();
  private pauseButtons = new Map<string, ButtonComponent>();
  private topologyElement?: HTMLElement;
  private reconciliationElement?: HTMLElement;
  private activeSection: SettingsSection = "topology";
  private visible = false;
  private configRevealed = false;

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
    if (!this.plugin.settings.onboardingComplete) {
      this.renderOnboarding(containerEl);
      return;
    }
    this.renderSectionTabs(containerEl);
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
              await this.plugin.saveSettings();
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
    const tabs = container.createDiv({ cls: "tephramesh-tabs" });
    tabs.setAttribute("role", "tablist");
    for (const section of SETTINGS_SECTIONS) {
      const active = section.id === this.activeSection;
      const button = tabs.createEl("button", {
        text: section.label,
        cls: active ? "tephramesh-tab is-active" : "tephramesh-tab",
      });
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(active));
      button.addEventListener("click", () => {
        if (this.activeSection === section.id) return;
        if (this.activeSection === "config") this.configRevealed = false;
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
      case "topology":
        this.renderTopology(sectionContainer);
        break;
    }
  }

  private renderMesh(container: HTMLElement): void {
    container.createEl("h2", { text: "Vault mesh" });
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
            await this.plugin.saveSettings();
            this.plugin.restartPolling();
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
            this.plugin.settings.offlineTimeoutSeconds = Number(value);
            await this.plugin.saveSettings();
            await this.plugin.refreshStatuses(true);
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
    new Setting(container)
      .setName("Delete Config")
      .setDesc("Erase Tephramesh's encrypted plugin data for this vault.")
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

  private renderConfig(container: HTMLElement): void {
    container.createEl("h2", { text: "Decrypted plugin config" });
    container.createEl("p", {
      text: "Read-only view of the currently unlocked configuration. It includes API keys and the shard encryption key; keep this screen private.",
      cls: "tephramesh-config-warning",
    });
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
    if (!this.configRevealed) {
      new Setting(container)
        .setName("View decrypted configuration")
        .setDesc("The view includes API keys and the shard encryption key; keep it private.")
        .addButton((button) => button.setButtonText("Show config").onClick(() => {
          this.configRevealed = true;
          this.render();
        }));
      return;
    }
    const config = this.plugin.getDecryptedConfig();
    if (!config) {
      container.createEl("p", { text: "Unlock Tephramesh to view the decrypted configuration." });
      return;
    }
    const pre = container.createEl("pre", { cls: "tephramesh-config-json" });
    pre.createEl("code").setText(JSON.stringify(config, null, 2));
  }

  private renderInstances(container: HTMLElement): void {
    const heading = container.createDiv({ cls: "tephramesh-heading-row" });
    heading.createEl("h2", { text: "Instances" });
    const controls = heading.createDiv();
    for (const kind of ["device", "shard"] as const) {
      const button = controls.createEl("button", {
        text: `Add ${kind}`,
        cls: kind === "device" ? "mod-cta" : undefined,
      });
      button.addEventListener("click", () => this.openInstanceModal(kind));
    }

    for (const instance of this.plugin.settings.instances) {
      const setting = new Setting(container);
      setting.settingEl.addClass("tephramesh-instance-card");
      setting.nameEl.empty();
      setting.nameEl.createSpan({
        text: instance.kind === "shard" ? "Shard" : "Device",
        cls: `tephramesh-instance-kind is-${instance.kind}`,
      });
      setting.nameEl.appendText(` ${instance.name}`);
      const operatingSystem = setting.nameEl.createSpan({
        cls: "tephramesh-instance-os",
      });
      this.operatingSystemElements.set(instance.id, operatingSystem);
      this.updateOperatingSystemElement(
        operatingSystem,
        this.plugin.runtimeStatuses.get(instance.id),
      );
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
      const url = endpointUrl(instance.endpoint);
      setting.descEl.empty();
      const link = setting.descEl.createEl("a", {
        text: url,
        href: url,
        cls: "tephramesh-instance-url",
      });
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
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
    }
    for (const known of this.plugin.settings.knownDevices) {
      const setting = new Setting(container);
      setting.settingEl.addClass("tephramesh-instance-card");
      setting.nameEl.empty();
      setting.nameEl.createSpan({ text: "Known", cls: "tephramesh-instance-kind is-known" });
      setting.nameEl.appendText(` ${known.name}`);
      setting.nameEl.createSpan({ text: ` · ${shortDeviceId(known.deviceId)}`, cls: "tephramesh-instance-heading-meta" });
      setting.descEl.setText("A trusted Syncthing peer outside the Tephramesh mesh.");
    }
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
    container.createEl("h2", { text: "Topology preview" });
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
    this.topologyElement.removeClass("is-valid", "is-incomplete");
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

      const operatingSection = this.topologyElement.createDiv({ cls: "tephramesh-topology-section tephramesh-topology-operating" });
      const operatingHeading = operatingSection.createDiv({ cls: "tephramesh-topology-heading" });
      operatingHeading.createEl("h3", { text: "Operating now" });
      const status = operatingHeading.createDiv({
        cls: "tephramesh-topology-status",
      });
      status.createSpan({ cls: `tephramesh-topology-indicator is-${healthState}` });
      const statusText = status.createDiv();
      statusText.createEl("strong", { text: healthState === "healthy" ? "Healthy" : "Warning" });
      const runtimeGroup = operatingSection.createDiv({
        cls: "tephramesh-topology-runtime-group",
      });
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
      operatingSection.createDiv({
        cls: "tephramesh-topology-subtitle",
        text: operatingInstances.length === activeInstances.length
          ? "Reachable instances currently participating in the mesh."
          : unavailableInstancesSummary(activeInstances, operatingInstances),
      });
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
    if (status.folderPaused) {
      element.addClass("is-paused");
      element.createDiv({
        text: `paused · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files · ${pending} pending`,
      });
      this.renderPendingFiles(element, status.pendingFiles);
      return;
    }
    if (folder.state === "scanning") {
      element.addClass("is-scanning");
      const progress = folder.scanProgress;
      element.createDiv({
        text: `scanning · ${progress === undefined ? "calculating…" : `${progress}%`} · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files`,
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
        text: `syncing · ${progress === undefined ? "calculating…" : `${progress}%`} · ↓ ${formatTransferRate(status.downloadBytesPerSecond)} · ↑ ${formatTransferRate(status.uploadBytesPerSecond)} · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files · ${pending} pending`,
      });
      this.renderPendingFiles(element, status.pendingFiles);
      return;
    }
    element.createDiv({
      text: `${folder.state} · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files · ${pending} pending`,
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
