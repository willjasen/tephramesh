import { App, Modal, Setting } from "obsidian";
import { showTephrameshNotice } from "./notices";

export class RestoreConfigVersionModal extends Modal {
  private busy = false;

  constructor(
    app: App,
    private readonly version: number,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Restore config version ${this.version}?` });
    contentEl.createEl("p", {
      text: "This replaces the running plugin settings and secrets with the selected snapshot.",
    });
    contentEl.createEl("p", {
      text: "The selected snapshot is saved as a new latest version, so the existing history remains available. Syncthing configuration and vault files are not changed by this action.",
      cls: "setting-item-description",
    });

    const actions = new Setting(contentEl);
    actions.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
    actions.addButton((button) =>
      button.setButtonText("Restore version").setWarning().onClick(async () => {
        if (this.busy) return;
        this.busy = true;
        button.setDisabled(true).setButtonText("Restoring…");
        try {
          await this.onConfirm();
          this.close();
        } catch (error) {
          showTephrameshNotice("error", "Config restore failed", error instanceof Error ? error.message : String(error));
          this.busy = false;
          button.setDisabled(false).setButtonText("Restore version");
        }
      }),
    );
  }
}
