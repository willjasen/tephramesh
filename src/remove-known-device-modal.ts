import { App, Modal, Setting } from "obsidian";
import type { KnownDevice } from "./model";
import { showTephrameshNotice } from "./notices";

export class RemoveKnownDeviceModal extends Modal {
  private busy = false;

  constructor(
    app: App,
    private readonly device: KnownDevice,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Remove ${this.device.name} from Known?` });
    contentEl.createEl("p", {
      text: "This removes the saved Known record. It does not immediately change Syncthing configuration or delete files.",
    });
    contentEl.createEl("p", {
      text: "Future mesh repair will no longer preserve this peer's managed-folder share.",
      cls: "setting-item-description",
    });

    const actions = new Setting(contentEl);
    actions.addButton((button) =>
      button.setButtonText("Cancel").onClick(() => this.close()),
    );
    actions.addButton((button) =>
      button
        .setButtonText("Remove Known device")
        .setWarning()
        .onClick(async () => {
          if (this.busy) return;
          this.busy = true;
          button.setDisabled(true).setButtonText("Removing…");
          try {
            await this.onConfirm();
            this.close();
          } catch (error) {
            showTephrameshNotice(
              "error",
              "Removal failed",
              error instanceof Error ? error.message : String(error),
            );
            this.busy = false;
            button.setDisabled(false).setButtonText("Remove Known device");
          }
        }),
    );
  }
}
