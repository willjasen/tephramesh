import { MarkdownView, type TFile, type WorkspaceLeaf } from "obsidian";

export interface EncryptedFileViewHost {
  decryptEncryptedFile(file: TFile): Promise<string>;
  saveEncryptedFile(file: TFile, plaintext: string): Promise<void>;
}

export class EncryptedFileView extends MarkdownView {
  static readonly VIEW_TYPE = "tephramesh-encrypted-file";

  private readonly host: EncryptedFileViewHost;
  private loading = false;
  private dirty = false;
  private viewDataVersion = 0;

  constructor(leaf: WorkspaceLeaf, host: EncryptedFileViewHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return EncryptedFileView.VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Encrypted file";
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info !== this || this.loading) return;
      this.dirty = true;
      this.requestSave();
    }));
  }

  async onLoadFile(file: TFile): Promise<void> {
    const viewDataVersion = ++this.viewDataVersion;
    this.loading = true;
    try {
      const plaintext = await this.host.decryptEncryptedFile(file);
      if (viewDataVersion !== this.viewDataVersion) return;
      await super.onLoadFile(file);
      super.setViewData(plaintext, true);
      this.dirty = false;
    } finally {
      this.loading = false;
    }
  }

  async onUnloadFile(file: TFile): Promise<void> {
    await this.save();
    await super.onUnloadFile(file);
  }

  getViewData(): string {
    return super.getViewData();
  }

  setViewData(data: string, clear: boolean): void {
    if (this.loading) return;
    if (data.startsWith("age-encryption.org/v1")) {
      const file = this.file;
      if (!file) return;
      const viewDataVersion = ++this.viewDataVersion;
      this.loading = true;
      void this.host.decryptEncryptedFile(file).then((plaintext) => {
        if (viewDataVersion !== this.viewDataVersion) return;
        super.setViewData(plaintext, clear);
        this.dirty = false;
      }).catch(() => {
        if (viewDataVersion === this.viewDataVersion) this.leaf.detach();
      }).finally(() => {
        if (viewDataVersion === this.viewDataVersion) this.loading = false;
      });
      return;
    }
    super.setViewData(data, clear);
  }

  async save(clear = false): Promise<void> {
    if (!this.file) return;
    if (!this.dirty) return;
    await this.host.saveEncryptedFile(this.file, super.getViewData());
    this.dirty = false;
    if (clear) super.clear();
  }
}
