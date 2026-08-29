import { App, ButtonComponent, Modal, Setting } from "obsidian";
import type TephrameshPlugin from "./main";
import { showTephrameshNotice } from "./notices";

type ReviewedInstallation = ReturnType<TephrameshPlugin["reviewEnrollmentCode"]>;

export class ApproveEnrollmentModal extends Modal {
  private requestCode = "";
  private reviewedCode = "";
  private busy = false;

  constructor(
    app: App,
    private readonly plugin: TephrameshPlugin,
    private readonly onApproved: (approval: string, installation: ReviewedInstallation) => void,
    private readonly onCancelled: (cancellation: string, installation: ReviewedInstallation) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Approve another installation" });
    contentEl.createEl("p", {
      text: "Paste the request generated on the other installation. Review its device and key before approving it.",
    });

    let actionButton: ButtonComponent | undefined;
    let cancelRequestButton: ButtonComponent | undefined;
    new Setting(contentEl)
      .setName("Enrollment request")
      .setDesc("The request is reviewed before it can be approved.")
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.setPlaceholder("Paste enrollment request").onChange((value) => {
          this.requestCode = value.trim();
          this.reviewedCode = "";
          actionButton?.buttonEl.removeClass("tephramesh-approve-button");
          actionButton?.setDisabled(!this.requestCode);
          actionButton?.setButtonText("Review request");
          cancelRequestButton?.setDisabled(true);
        });
      })
      .addButton((button) => {
        actionButton = button;
        return button.setButtonText("Review request").setDisabled(true).onClick(async () => {
          if (this.busy) return;
          this.busy = true;
          button.setDisabled(true).setButtonText("Signing…");
          try {
            if (this.reviewedCode !== this.requestCode) {
              const review = this.plugin.reviewEnrollmentCode(this.requestCode);
              this.reviewedCode = this.requestCode;
              button.buttonEl.addClass("tephramesh-approve-button");
              button.setDisabled(false).setButtonText(`Approve ${review.deviceName}`);
              cancelRequestButton?.setDisabled(false).setButtonText(`Cancel ${review.deviceName}'s request`);
              showTephrameshNotice(
                "warning",
                "Review enrollment request",
                `${review.deviceName} · ${review.source === "known" ? "Known device" : "Active device"} · signing key ${review.keyId.slice(0, 12)}. Click Approve only if this is the installation you expect.`,
              );
              this.busy = false;
              return;
            }
            const approval = await this.plugin.approveEnrollmentCode(this.requestCode);
            const installation = this.plugin.reviewEnrollmentCode(this.requestCode);
            await navigator.clipboard.writeText(approval);
            this.onApproved(approval, installation);
            this.close();
            showTephrameshNotice(
              "success",
              "Enrollment approval copied",
              "Use the pending device's Copy approval button if you need to copy it again.",
            );
          } catch (error) {
            showTephrameshNotice("error", "Approval failed", error instanceof Error ? error.message : String(error));
            this.busy = false;
            button.setDisabled(false).setButtonText("Review request");
            button.buttonEl.removeClass("tephramesh-approve-button");
            this.reviewedCode = "";
          }
        });
      });

    new Setting(contentEl)
      .setName("Cancel enrollment request")
      .setDesc("Creates a signed cancellation that the requesting installation can verify.")
      .addButton((button) => {
        cancelRequestButton = button;
        return button.setButtonText("Cancel request").setWarning().setDisabled(true).onClick(async () => {
          if (this.busy || this.reviewedCode !== this.requestCode) return;
          this.busy = true;
          button.setDisabled(true).setButtonText("Signing cancellation…");
          try {
            const installation = this.plugin.reviewEnrollmentCode(this.requestCode);
            const cancellation = await this.plugin.cancelEnrollmentCode(this.requestCode);
            await navigator.clipboard.writeText(cancellation);
            this.onCancelled(cancellation, installation);
            this.close();
            showTephrameshNotice(
              "success",
              "Enrollment cancellation copied",
              "Paste it into the requesting installation to clear its pending request.",
            );
          } catch (error) {
            showTephrameshNotice("error", "Cancellation failed", error instanceof Error ? error.message : String(error));
            this.busy = false;
            button.setDisabled(false).setButtonText("Cancel request");
          }
        });
      });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }
}
