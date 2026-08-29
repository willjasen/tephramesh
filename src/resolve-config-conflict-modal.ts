import { App, Modal, Setting } from "obsidian";
import { showTephrameshNotice } from "./notices";

export class ResolveConfigConflictModal extends Modal {
  private busy = false;

  constructor(
    app: App,
    private readonly revision: number,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Keep the synchronized configuration?" });
    contentEl.createEl("p", {
      text: `This installation will accept the currently synchronized revision ${this.revision} and sign its contents as a new revision.`,
    });
    contentEl.createEl("p", {
      text: "Any journaled competing revision remains encrypted for future recovery. Syncthing configuration and vault files are not changed by this action.",
      cls: "setting-item-description",
    });

    const actions = new Setting(contentEl);
    actions.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
    actions.addButton((button) =>
      button.setButtonText("Keep synchronized config").setWarning().onClick(async () => {
        if (this.busy) return;
        this.busy = true;
        button.setDisabled(true).setButtonText("Resolving…");
        try {
          await this.onConfirm();
          this.close();
        } catch (error) {
          showTephrameshNotice(
            "error",
            "Conflict resolution failed",
            error instanceof Error ? error.message : String(error),
          );
          this.busy = false;
          button.setDisabled(false).setButtonText("Keep synchronized config");
        }
      }),
    );
  }
}
