import {
  App,
  ButtonComponent,
  DropdownComponent,
  Modal,
  Setting,
  TextComponent,
} from "obsidian";
import type { Endpoint, MeshInstance } from "./model";
import {
  endpointUrl,
  normalizeEndpointPath,
  parseEndpointUrl,
  validateEndpoint,
} from "./security";
import { showTephrameshNotice } from "./notices";
import { SyncthingClient } from "./syncthing-client";

export class EditEndpointModal extends Modal {
  private endpoint: Endpoint;
  private testedSignature = "";
  private busy = false;
  private urlError = "";
  private testButton?: ButtonComponent;
  private saveButton?: ButtonComponent;
  private urlInput?: TextComponent;
  private protocolInput?: DropdownComponent;
  private hostnameInput?: TextComponent;
  private portInput?: TextComponent;
  private pathInput?: TextComponent;

  constructor(
    app: App,
    private readonly instance: MeshInstance,
    private readonly apiKey: string,
    private readonly onSave: (endpoint: Endpoint) => Promise<void>,
  ) {
    super(app);
    this.endpoint = { ...instance.endpoint };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("tephramesh-instance-modal");
    contentEl.createEl("h2", { text: `Edit ${this.instance.kind} URL` });
    contentEl.createEl("p", {
      text: `Test must confirm that the new URL still reaches ${this.instance.name} (${this.instance.deviceId}).`,
      cls: "setting-item-description",
    });

    new Setting(contentEl)
      .setName("Syncthing URL")
      .setDesc("Enter the complete web UI URL, including any reverse-proxy path.")
      .addText((text) => {
        this.urlInput = text;
        text.setValue(endpointUrl(this.endpoint)).onChange((value) => {
          try {
            this.endpoint = parseEndpointUrl(value);
            this.urlError = "";
            this.syncComponents();
          } catch (error) {
            this.urlError = error instanceof Error ? error.message : String(error);
          }
          this.invalidateTest();
        });
      });

    new Setting(contentEl).setName("Protocol").addDropdown((dropdown) => {
      this.protocolInput = dropdown;
      dropdown
        .addOption("http", "HTTP")
        .addOption("https", "HTTPS")
        .setValue(this.endpoint.protocol)
        .onChange((value) => {
          this.endpoint.protocol = value as Endpoint["protocol"];
          this.syncUrl();
        });
    });
    new Setting(contentEl).setName("Hostname").addText((text) => {
      this.hostnameInput = text;
      text.setValue(this.endpoint.hostname).onChange((value) => {
        this.endpoint.hostname = value.trim();
        this.syncUrl();
      });
    });
    new Setting(contentEl).setName("Port").addText((text) => {
      this.portInput = text;
      text.setValue(String(this.endpoint.port)).onChange((value) => {
        this.endpoint.port = Number(value);
        this.syncUrl();
      });
    });
    new Setting(contentEl)
      .setName("URL path")
      .setDesc("Optional path prefix used by a reverse proxy.")
      .addText((text) => {
        this.pathInput = text;
        text.setValue(this.endpoint.path ?? "").onChange((value) => {
          this.endpoint.path = normalizeEndpointPath(value);
          this.syncUrl();
        });
      });

    const actions = new Setting(contentEl);
    actions.addButton((button) =>
      button.setButtonText("Cancel").onClick(() => this.close()),
    );
    actions.addButton((button) => {
      this.testButton = button;
      button.setButtonText("Test").onClick(() => void this.test());
    });
    actions.addButton((button) => {
      this.saveButton = button;
      button
        .setButtonText("Save")
        .setCta()
        .setDisabled(true)
        .onClick(() => void this.save());
    });
  }

  private syncComponents(): void {
    this.protocolInput?.setValue(this.endpoint.protocol);
    this.hostnameInput?.setValue(this.endpoint.hostname);
    this.portInput?.setValue(String(this.endpoint.port));
    this.pathInput?.setValue(this.endpoint.path ?? "");
  }

  private syncUrl(): void {
    this.urlError = "";
    this.urlInput?.setValue(this.endpoint.hostname ? endpointUrl(this.endpoint) : "");
    this.invalidateTest();
  }

  private signature(): string {
    return JSON.stringify(this.endpoint);
  }

  private invalidateTest(): void {
    this.testedSignature = "";
    this.saveButton?.setDisabled(true);
  }

  private validate(): void {
    if (this.urlError) throw new Error(this.urlError);
    const error = validateEndpoint(this.endpoint, { onboarding: false });
    if (error) throw new Error(error);
  }

  private async test(): Promise<void> {
    if (this.busy) return;
    this.setBusy("test");
    try {
      this.validate();
      const client = new SyncthingClient(this.endpoint, this.apiKey);
      const [status, version] = await Promise.all([
        client.getSystemStatus(),
        client.getVersion(),
      ]);
      if (status.myID !== this.instance.deviceId) {
        throw new Error(
          `This URL reports device ${status.myID}, but ${this.instance.name} is ${this.instance.deviceId}.`,
        );
      }
      this.testedSignature = this.signature();
      showTephrameshNotice(
        "success",
        "Connection successful",
        `Confirmed ${this.instance.name} · Syncthing ${version.version}.`,
      );
    } catch (error) {
      this.invalidateTest();
      showTephrameshNotice(
        "error",
        "Test failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.setBusy(null);
    }
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    if (this.testedSignature !== this.signature()) {
      showTephrameshNotice("warning", "Test required", "Test the current URL before saving it.");
      this.invalidateTest();
      return;
    }
    this.setBusy("save");
    try {
      await this.onSave({ ...this.endpoint });
      showTephrameshNotice("success", "URL updated", this.instance.name);
      this.close();
    } catch (error) {
      showTephrameshNotice(
        "error",
        "Update failed",
        error instanceof Error ? error.message : String(error),
      );
      this.setBusy(null);
    }
  }

  private setBusy(operation: "test" | "save" | null): void {
    this.busy = operation !== null;
    this.testButton
      ?.setDisabled(this.busy)
      .setButtonText(operation === "test" ? "Testing…" : "Test");
    this.saveButton
      ?.setDisabled(this.busy || this.testedSignature !== this.signature())
      .setButtonText(operation === "save" ? "Saving…" : "Save");
  }
}
