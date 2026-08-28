import {
  App,
  ButtonComponent,
  DropdownComponent,
  FileSystemAdapter,
  Modal,
  Setting,
  TextComponent,
} from "obsidian";
import type { Endpoint, InstanceKind, MeshInstance, SyncthingFolder } from "./model";
import {
  endpointUrl,
  generateSyncthingFolderId,
  normalizeEndpointPath,
  parseEndpointUrl,
  validateEndpoint,
} from "./security";
import { SyncthingClient } from "./syncthing-client";
import { showTephrameshNotice } from "./notices";
import { localSyncthingDeviceName } from "./syncthing-device";
import { suggestSyncthingFolderPath } from "./syncthing-folder";
import { MeshNotReadyError } from "./mesh-errors";

interface InstanceDraft {
  kind: InstanceKind;
  endpoint: Endpoint;
  apiKey: string;
  folderPath: string;
}

export interface InstanceDiscovery {
  instance: MeshInstance;
  discoveredFolder?: { id: string; label: string };
  version: string;
  operatingSystem?: string;
}

interface InspectionResult {
  discovery: InstanceDiscovery;
  folderCreated: boolean;
}

function newInstanceId(): string {
  return crypto.randomUUID?.() ?? `instance-${Date.now().toString(36)}`;
}

function localVaultPath(app: App): string {
  const adapter = app.vault.adapter;
  return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
}

function normalizedPath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

export class InstanceModal extends Modal {
  private readonly draft: InstanceDraft;
  private busy = false;
  private testedSignature = "";
  private addButton?: ButtonComponent;
  private testButton?: ButtonComponent;
  private apiKeyDescriptionEl?: HTMLElement;
  private endpointUrlInput?: TextComponent;
  private protocolInput?: DropdownComponent;
  private hostnameInput?: TextComponent;
  private portInput?: TextComponent;
  private pathInput?: TextComponent;
  private folderPathInput?: TextComponent;
  private discoveredName = "";
  private urlError = "";

  constructor(
    app: App,
    private readonly onboarding: boolean,
    kind: InstanceKind,
    private readonly folderId: string,
    private readonly folderLabel: string,
    private readonly beforeAdd: (result: InstanceDiscovery) => Promise<void>,
    private readonly onDiscovered: (
      result: InstanceDiscovery,
      apiKey: string,
    ) => Promise<void>,
    private readonly onPending?: (
      result: InstanceDiscovery,
      apiKey: string,
      reason: string,
    ) => Promise<void>,
  ) {
    super(app);
    this.draft = {
      kind: onboarding ? "device" : kind,
      endpoint: {
        protocol: onboarding ? "http" : "https",
        hostname: onboarding ? "localhost" : "",
        port: 8384,
        path: "",
      },
      apiKey: "",
      folderPath: onboarding ? localVaultPath(app) : "",
    };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("tephramesh-instance-modal");
    contentEl.createEl("h2", {
      text: this.onboarding ? "Connect this device" : `Add ${this.draft.kind}`,
    });
    contentEl.createEl("p", {
      text: this.onboarding
        ? "Tephramesh will only contact Syncthing through this device's loopback interface during first setup."
        : "The API must be reachable from this Obsidian device. Remote APIs require HTTPS.",
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName("Syncthing URL")
      .setDesc("Enter the complete web UI URL, including any reverse-proxy path.")
      .addText((text) => {
        this.endpointUrlInput = text;
        text
          .setPlaceholder("https://example.com/syncthing/")
          .setValue(
            this.draft.endpoint.hostname ? endpointUrl(this.draft.endpoint) : "",
          )
          .onChange((value) => this.applyEndpointUrl(value));
      });

    new Setting(contentEl)
      .setName("Protocol")
      .addDropdown((dropdown) => {
        this.protocolInput = dropdown;
        return dropdown
          .addOption("http", "HTTP")
          .addOption("https", "HTTPS")
          .setValue(this.draft.endpoint.protocol)
          .onChange((value) => {
            this.draft.endpoint.protocol = value as Endpoint["protocol"];
            this.syncUrlFromEndpoint();
            this.invalidateTest(true);
          });
      });

    new Setting(contentEl).setName("Hostname").addText((text) => {
      this.hostnameInput = text;
      text.setPlaceholder("localhost").setValue(this.draft.endpoint.hostname);
      if (this.onboarding) text.setDisabled(true);
      text.onChange((value) => {
        this.draft.endpoint.hostname = value.trim();
        this.syncUrlFromEndpoint();
        this.invalidateTest(true);
      });
    });

    new Setting(contentEl).setName("Port").addText((text) => {
      this.portInput = text;
      text.setValue(String(this.draft.endpoint.port)).onChange((value) => {
        this.draft.endpoint.port = Number(value);
        this.syncUrlFromEndpoint();
        this.invalidateTest(true);
      });
    });

    new Setting(contentEl)
      .setName("URL path")
      .setDesc("Optional path prefix used by a reverse proxy.")
      .addText((text) => {
        this.pathInput = text;
        text
          .setPlaceholder("/syncthing")
          .setValue(this.draft.endpoint.path ?? "")
          .onChange((value) => {
            this.draft.endpoint.path = normalizeEndpointPath(value);
            this.syncUrlFromEndpoint();
            this.invalidateTest(true);
          });
      });

    const apiKeySetting = new Setting(contentEl)
      .setName("Syncthing API key")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Paste API key").onChange((value) => {
          this.draft.apiKey = value.trim();
          this.invalidateTest(true);
        });
      });
    this.apiKeyDescriptionEl = apiKeySetting.descEl;
    this.updateApiKeyDescription();

    new Setting(contentEl)
      .setName(this.draft.kind === "shard" ? "Encrypted storage path" : "Vault path")
      .setDesc("The absolute path as seen by this Syncthing instance.")
      .addText((text) => {
        this.folderPathInput = text;
        text
          .setPlaceholder(this.onboarding ? "Vault path" : "Test to suggest a path")
          .setValue(this.draft.folderPath)
          .setDisabled(!this.onboarding)
          .onChange((value) => {
            this.draft.folderPath = value.trim();
            this.invalidateTest();
          });
      });

    const actions = new Setting(contentEl);
    actions.addButton((button) =>
      button.setButtonText("Cancel").onClick(() => this.close()),
    );
    actions.addButton((button) => {
      this.testButton = button;
      button.setButtonText("Test").onClick(() => void this.testConnection());
    });
    actions.addButton((button) => {
      this.addButton = button;
      button
        .setButtonText("Add")
        .setCta()
        .setDisabled(true)
        .onClick(() => void this.addInstance());
    });
  }

  onClose(): void {
    this.draft.apiKey = "";
    this.contentEl.empty();
  }

  private updateApiKeyDescription(): void {
    if (!this.apiKeyDescriptionEl) return;
    this.apiKeyDescriptionEl.setText(
      this.discoveredName
        ? "The API key will be protected inside the age-encrypted plugin configuration."
        : "Test discovers the device name from Syncthing. The API key will be stored in the age-encrypted configuration.",
    );
  }

  private applyEndpointUrl(value: string): void {
    try {
      const endpoint = parseEndpointUrl(value);
      this.urlError = "";
      this.draft.endpoint = endpoint;
      this.protocolInput?.setValue(endpoint.protocol);
      this.hostnameInput?.setValue(endpoint.hostname);
      this.portInput?.setValue(String(endpoint.port));
      this.pathInput?.setValue(endpoint.path ?? "");
    } catch (error) {
      this.urlError = error instanceof Error ? error.message : String(error);
    }
    this.invalidateTest(true);
  }

  private syncUrlFromEndpoint(): void {
    this.urlError = "";
    this.endpointUrlInput?.setValue(
      this.draft.endpoint.hostname ? endpointUrl(this.draft.endpoint) : "",
    );
  }

  private invalidateTest(resetSuggestedPath = false): void {
    this.testedSignature = "";
    this.discoveredName = "";
    if (resetSuggestedPath && !this.onboarding) {
      this.draft.folderPath = "";
      this.folderPathInput?.setValue("").setDisabled(true);
    }
    this.updateApiKeyDescription();
    this.addButton?.setDisabled(true);
  }

  private signature(): string {
    return JSON.stringify(this.draft);
  }

  private async testConnection(): Promise<void> {
    if (this.busy) return;
    this.setBusy("test");
    try {
      const result = await this.inspect(false);
      this.folderPathInput?.setValue(this.draft.folderPath).setDisabled(false);
      this.discoveredName = result.discovery.instance.name;
      this.updateApiKeyDescription();
      this.testedSignature = this.signature();
      this.addButton?.setDisabled(false);
      const folderMessage = result.discovery.discoveredFolder
        ? `Folder “${result.discovery.discoveredFolder.label}” already exists.`
        : "The vault folder does not exist yet and will be created when you select Add.";
      showTephrameshNotice(
        "success",
        "Connection successful",
        `Device “${result.discovery.instance.name}” · Syncthing ${result.discovery.version}. ${folderMessage}`,
      );
    } catch (error) {
      this.invalidateTest();
      this.showError(error);
    } finally {
      this.setBusy(null);
    }
  }

  private async addInstance(): Promise<void> {
    if (this.busy) return;
    if (this.testedSignature !== this.signature()) {
      showTephrameshNotice(
        "warning",
        "Test required",
        "Test the current settings before adding this instance.",
      );
      this.invalidateTest();
      return;
    }
    this.setBusy("add");
    let inspected: InspectionResult | undefined;
    try {
      inspected = await this.inspect(false);
      await this.beforeAdd(inspected.discovery);
      const result = await this.inspect(true);
      await this.onDiscovered(result.discovery, this.draft.apiKey);
      showTephrameshNotice(
        "success",
        "Instance added",
        result.folderCreated
          ? "The Syncthing folder was created and the instance was added."
          : "The instance was added using the existing Syncthing folder.",
      );
      this.close();
    } catch (error) {
      if (error instanceof MeshNotReadyError && inspected && this.onPending) {
        try {
          await this.onPending(
            inspected.discovery,
            this.draft.apiKey,
            error.message,
          );
          showTephrameshNotice(
            "warning",
            "Instance saved as pending",
            `${error.message} Use Pending setup from the Instances tab when the mesh is ready.`,
          );
          this.close();
          return;
        } catch (pendingError) {
          this.showError(pendingError);
        }
      } else if (error instanceof MeshNotReadyError) {
        showTephrameshNotice("warning", "Mesh not ready", error.message);
        this.invalidateTest();
      } else {
        this.showError(error);
      }
      this.setBusy(null);
    }
  }

  private setBusy(operation: "test" | "add" | null): void {
    this.busy = operation !== null;
    this.testButton
      ?.setDisabled(this.busy)
      .setButtonText(operation === "test" ? "Testing…" : "Test");
    this.addButton
      ?.setDisabled(this.busy || this.testedSignature !== this.signature())
      .setButtonText(operation === "add" ? "Adding…" : "Add");
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    showTephrameshNotice("error", "Error", message);
  }

  private apiKey(): string {
    if (!this.draft.apiKey) throw new Error("Enter the Syncthing API key.");
    return this.draft.apiKey;
  }

  private validateEndpoint(): void {
    if (this.urlError) throw new Error(this.urlError);
    const endpointError = validateEndpoint(this.draft.endpoint, {
      onboarding: this.onboarding,
    });
    if (endpointError) throw new Error(endpointError);
  }

  private findFolder(folders: SyncthingFolder[]): SyncthingFolder | undefined {
    const path = normalizedPath(this.draft.folderPath);
    const byPath = folders.find((folder) => normalizedPath(folder.path) === path);
    if (!this.folderId) return byPath;

    const byId = folders.find((folder) => folder.id === this.folderId);
    if (byId && normalizedPath(byId.path) !== path) {
      throw new Error(
        `Folder ID “${this.folderId}” already uses a different path on this instance.`,
      );
    }
    if (byPath && byPath.id !== this.folderId) {
      throw new Error(
        `This path already belongs to Syncthing folder “${byPath.id}”, not “${this.folderId}”.`,
      );
    }
    return byId;
  }

  private async inspect(createMissingFolder: boolean): Promise<InspectionResult> {
    this.validateEndpoint();
    const apiKey = this.apiKey();
    const client = new SyncthingClient(this.draft.endpoint, apiKey);
    const [status, version, folders, devices, defaultFolder] = await Promise.all([
      client.getSystemStatus(),
      client.getVersion(),
      client.getFolders(),
      client.getDevices(),
      client.getDefaultFolder(),
    ]);
    const deviceName = localSyncthingDeviceName(devices, status.myID);
    if (!deviceName) {
      throw new Error("Syncthing did not report a name for its local device.");
    }
    if (!this.draft.folderPath && this.folderId) {
      this.draft.folderPath = suggestSyncthingFolderPath(
        folders,
        defaultFolder,
        this.folderId,
      );
    }
    if (!this.draft.folderPath) throw new Error("Folder path is required.");
    let matchingFolder = this.findFolder(folders);
    let folderCreated = false;

    if (!matchingFolder && createMissingFolder) {
      const id = this.folderId || generateSyncthingFolderId();
      matchingFolder = await client.createFolder(
        id,
        this.folderLabel,
        this.draft.folderPath,
        this.draft.kind === "shard" ? "receiveencrypted" : "sendreceive",
      );
      folderCreated = true;
    }

    return {
      folderCreated,
      discovery: {
        instance: {
          id: newInstanceId(),
          name: deviceName,
          kind: this.draft.kind,
          endpoint: { ...this.draft.endpoint },
          deviceId: status.myID,
          folderPath: matchingFolder?.path ?? this.draft.folderPath,
        },
        discoveredFolder: matchingFolder
          ? { id: matchingFolder.id, label: matchingFolder.label }
          : undefined,
        version: version.version,
        operatingSystem: version.os,
      },
    };
  }
}
