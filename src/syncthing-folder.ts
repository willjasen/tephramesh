import type { SyncthingFolder } from "./model";

function appendPath(basePath: string, child: string): string {
  const base = basePath.replace(/[\\/]+$/, "");
  if (!base || base === ".") return child;
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base}${separator}${child}`;
}

export function suggestSyncthingFolderPath(
  folders: SyncthingFolder[],
  defaultFolder: SyncthingFolder,
  folderId: string,
): string {
  const existing = folders.find((folder) => folder.id === folderId);
  if (existing?.path.trim()) return existing.path;
  const defaultPath = folders.find((folder) => folder.id === "default")?.path.trim();
  return appendPath(defaultPath || defaultFolder.path.trim(), folderId);
}

export function buildSyncthingFolder(
  template: SyncthingFolder,
  id: string,
  label: string,
  path: string,
  type: "sendreceive" | "receiveencrypted",
): SyncthingFolder {
  return {
    ...template,
    id,
    label,
    path,
    type,
    paused: false,
  };
}
