import { App, Modal, Setting } from "obsidian";
import { showTephrameshNotice } from "./notices";

export class DeleteConfigModal extends Modal {
  private busy = false;

  constructor(
    app: App,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Delete Tephramesh config?" });
    contentEl.createEl("p", {
      text: "This permanently erases Tephramesh's encrypted plugin data for this vault, including its instance list, API keys, and shard encryption key.",
    });
    contentEl.createEl("p", {
      text: "Syncthing configuration and vault files will not be changed. The private age identity will remain in this device's Obsidian Keychain.",
      cls: "setting-item-description",
    });

    const actions = new Setting(contentEl);
    actions.addButton((button) =>
      button.setButtonText("Cancel").onClick(() => this.close()),
    );
    actions.addButton((button) =>
      button
        .setButtonText("Delete config")
        .setWarning()
        .onClick(async () => {
          if (this.busy) return;
          this.busy = true;
          button.setDisabled(true).setButtonText("Deleting…");
          try {
            await this.onConfirm();
            this.close();
          } catch (error) {
            showTephrameshNotice(
              "error",
              "Config deletion failed",
              error instanceof Error ? error.message : String(error),
            );
            this.busy = false;
            button.setDisabled(false).setButtonText("Delete config");
          }
        }),
    );
  }
}
