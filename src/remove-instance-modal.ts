import { App, Modal, Setting } from "obsidian";
import type { MeshInstance } from "./model";
import { showTephrameshNotice } from "./notices";

export class RemoveInstanceModal extends Modal {
  private busy = false;

  constructor(
    app: App,
    private readonly instance: MeshInstance,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Remove ${this.instance.name}?` });
    contentEl.createEl("p", {
      text: "The managed folder will be removed from this Syncthing instance, and the remaining instances will stop sharing the folder with it.",
    });
    contentEl.createEl("p", {
      text: `Files already stored at ${this.instance.folderPath} will remain on disk. Tephramesh will not delete them.`,
      cls: "setting-item-description",
    });

    const actions = new Setting(contentEl);
    actions.addButton((button) =>
      button.setButtonText("Cancel").onClick(() => this.close()),
    );
    actions.addButton((button) =>
      button
        .setButtonText("Remove folder")
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
            button.setDisabled(false).setButtonText("Remove folder");
          }
        }),
    );
  }
}
