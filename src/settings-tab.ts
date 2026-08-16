import {
  App,
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
import { activeMeshInstances, createMeshPlan, meshRuntimeStates } from "./topology";
import { InstanceModal } from "./instance-modal";
import { showTephrameshNotice } from "./notices";
import { RemoveInstanceModal } from "./remove-instance-modal";
import { AgeIdentityBackupModal } from "./age-identity-backup-modal";
import { generatePostQuantumAgeKeyPair } from "./secret-bundle";
import { syncProgress } from "./syncthing-progress";
import { formatTransferRate } from "./syncthing-traffic";
import { EditEndpointModal } from "./edit-endpoint-modal";
import { MeshNotReadyError } from "./mesh-errors";

type SettingsSection = "instances" | "vault" | "topology";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "topology", label: "Topology" },
  { id: "instances", label: "Instances" },
  { id: "vault", label: "Vault" },
];

export class TephrameshSettingTab extends PluginSettingTab {
  private statusElements = new Map<string, HTMLElement>();
  private versionElements = new Map<string, HTMLElement>();
  private topologyElement?: HTMLElement;
  private activeSection: SettingsSection = "topology";

  constructor(app: App, private readonly plugin: TephrameshPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("tephramesh-settings");
    this.statusElements.clear();
    this.versionElements.clear();
    this.topologyElement = undefined;
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
    this.updateTopology();
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
              this.plugin.setKnownHealthy(result.instance.id, result.version);
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
      setting.addButton((button) =>
        button.setIcon("refresh-cw").setTooltip("Refresh status").onClick(async () => {
          await this.plugin.refreshInstanceStatus(instance);
        }),
      );
      if (instance.id !== this.plugin.settings.primaryInstanceId) {
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
        this.plugin.setKnownHealthy(result.instance.id, result.version);
        this.display();
        await this.plugin.refreshStatuses();
      },
      async (result, apiKey) => {
        await this.plugin.savePendingInstance(result.instance, apiKey);
        this.plugin.setKnownHealthy(result.instance.id, result.version);
        this.display();
      },
    ).open();
  }

  private renderTopology(container: HTMLElement): void {
    container.createEl("h2", { text: "Topology preview" });
    this.topologyElement = container.createDiv({ cls: "tephramesh-topology" });
    this.updateTopology();
    new Setting(container)
      .setName("Automatic reconciliation")
      .setDesc("New instances are reconciled during Add. General repair of previously drifted topology is coming next.")
      .addButton((button) => button.setButtonText("Coming next").setDisabled(true));
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
      const devices = activeInstances.filter((item) => item.kind === "device").length;
      const shards = activeInstances.length - devices;
      const activeCount = activeInstances.length;
      const activeConnections = (activeCount * (activeCount - 1)) / 2;
      const reportedGlobalFiles = this.plugin.settings.instances.flatMap(
        (instance) => {
          const count = this.plugin.runtimeStatuses.get(instance.id)?.folder?.globalFiles;
          return typeof count === "number" && Number.isFinite(count) ? [count] : [];
        },
      );
      const globalFiles =
        reportedGlobalFiles.length > 0 ? Math.max(...reportedGlobalFiles) : undefined;
      this.topologyElement.addClass("is-valid");

      const status = this.topologyElement.createDiv({
        cls: "tephramesh-topology-status",
      });
      status.createSpan({ cls: "tephramesh-topology-indicator" });
      const statusText = status.createDiv();
      statusText.createEl("strong", { text: "Plan valid" });
      statusText.createDiv({
        cls: "tephramesh-topology-subtitle",
        text: "The full mesh can be configured with the current settings.",
      });
      const runtimeGroup = status.createDiv({
        cls: "tephramesh-topology-runtime-group",
      });
      for (const runtimeState of meshRuntimeStates(
        this.plugin.settings.instances,
        this.plugin.runtimeStatuses,
      )) {
        runtimeGroup.createSpan({
          cls: `tephramesh-topology-runtime is-${runtimeState}`,
          text: runtimeState,
        });
      }

      const metrics = this.topologyElement.createDiv({
        cls: "tephramesh-topology-metrics",
      });
      for (const [label, value] of [
        [devices === 1 ? "Device" : "Devices", devices],
        [shards === 1 ? "Shard" : "Shards", shards],
        [activeConnections === 1 ? "Connection" : "Connections", activeConnections],
        ["Global files", globalFiles ?? "—"],
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
      details.createEl("p", {
        text: "All peer connections remain encrypted in transit by Syncthing.",
      });
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
    const version = status?.ok ? status.version : undefined;
    element.setText(` · ${version ?? "—"}`);
  }

  private updateStatusElement(
    element: HTMLElement,
    status: InstanceRuntimeStatus | undefined,
  ): void {
    element.empty();
    element.removeClass("is-error", "is-scanning", "is-syncing");
    if (!status) {
      element.setText("Not checked yet");
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
    if (folder.state === "scanning") {
      element.addClass("is-scanning");
      const progress = folder.scanProgress;
      element.setText(
        `scanning · ${progress === undefined ? "calculating…" : `${progress}%`} · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files`,
      );
      return;
    }
    if (folder.state === "syncing") {
      element.addClass("is-syncing");
      const progress = syncProgress(folder);
      element.setText(
        `syncing · ${progress === undefined ? "calculating…" : `${progress}%`} · ↓ ${formatTransferRate(status.downloadBytesPerSecond)} · ↑ ${formatTransferRate(status.uploadBytesPerSecond)} · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files · ${pending} pending`,
      );
      return;
    }
    element.setText(
      `${folder.state} · ${folder.localFiles ?? 0}/${folder.globalFiles ?? 0} files · ${pending} pending`,
    );
  }
}
