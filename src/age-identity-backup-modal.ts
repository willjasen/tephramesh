import { App, Modal, Setting } from "obsidian";

export class AgeIdentityBackupModal extends Modal {
  private completed = false;

  constructor(
    app: App,
    private readonly identity: string,
    private readonly onComplete: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Back up the private age identity" });
    contentEl.createEl("p", {
      text: "This is the only key that can decrypt the synced Tephramesh secrets. Save it securely before continuing; every other Obsidian installation will need it once.",
    });
    new Setting(contentEl)
      .setName("Private identity")
      .setDesc("Post-quantum age identity · never stored in the vault")
      .addTextArea((text) => {
        text.setValue(this.identity);
        text.inputEl.readOnly = true;
        text.inputEl.rows = 8;
      });
    const actions = new Setting(contentEl);
    actions.addButton((button) =>
      button.setButtonText("Copy identity").onClick(async () => {
        await navigator.clipboard.writeText(this.identity);
        button.setButtonText("Copied");
      }),
    );
    actions.addButton((button) =>
      button.setButtonText("I saved it").setCta().onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.completed) return;
    this.completed = true;
    this.onComplete();
  }
}
