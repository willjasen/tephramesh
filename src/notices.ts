import { Notice } from "obsidian";

export type NoticeTone = "success" | "warning" | "error";

export function showTephrameshNotice(
  tone: NoticeTone,
  title: string,
  message?: string,
): Notice {
  const content = document.createDocumentFragment();
  const titleElement = document.createElement("div");
  titleElement.className = `tephramesh-notice-title is-${tone}`;
  titleElement.textContent = `Tephramesh: ${title}`;
  content.appendChild(titleElement);

  if (message) {
    const messageElement = document.createElement("div");
    messageElement.className = "tephramesh-notice-message";
    messageElement.textContent = message;
    content.appendChild(messageElement);
  }

  return new Notice(content, tone === "error" ? 8000 : 6000);
}
