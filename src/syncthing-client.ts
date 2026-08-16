import { requestUrl, type RequestUrlParam } from "obsidian";
import type {
  Endpoint,
  SyncthingDevice,
  SyncthingFolder,
  SyncthingFolderScanProgressEvent,
  SyncthingFolderStatus,
  SyncthingConnections,
  SyncthingSystemStatus,
  SyncthingVersion,
} from "./model";
import { endpointUrl } from "./security";
import { buildSyncthingFolder } from "./syncthing-folder";
import { latestFolderScanProgress } from "./syncthing-scan";

export class SyncthingApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SyncthingApiError";
  }
}

export class SyncthingClient {
  constructor(
    private readonly endpoint: Endpoint,
    private readonly apiKey: string,
  ) {}

  private async request<T>(
    path: string,
    options: Pick<RequestUrlParam, "method" | "body"> = {},
  ): Promise<T> {
    const response = await requestUrl({
      url: `${endpointUrl(this.endpoint)}${path}`,
      method: options.method ?? "GET",
      body: options.body,
      contentType: options.body ? "application/json" : undefined,
      headers: {
        Accept: "application/json",
        "X-API-Key": this.apiKey,
      },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new SyncthingApiError(
        `Syncthing returned HTTP ${response.status}.`,
        response.status,
      );
    }
    if (!response.text) return undefined as T;
    return response.json as T;
  }

  async getSystemStatus(): Promise<SyncthingSystemStatus> {
    return this.request<SyncthingSystemStatus>("/rest/system/status");
  }

  async getVersion(): Promise<SyncthingVersion> {
    return this.request<SyncthingVersion>("/rest/system/version");
  }

  async getConnections(): Promise<SyncthingConnections> {
    return this.request<SyncthingConnections>("/rest/system/connections");
  }

  async getFolders(): Promise<SyncthingFolder[]> {
    return this.request<SyncthingFolder[]>("/rest/config/folders");
  }

  async getDefaultFolder(): Promise<SyncthingFolder> {
    return this.request<SyncthingFolder>("/rest/config/defaults/folder");
  }

  async getFolder(folderId: string): Promise<SyncthingFolder> {
    return this.request<SyncthingFolder>(
      `/rest/config/folders/${encodeURIComponent(folderId)}`,
    );
  }

  async updateFolderLabel(folderId: string, label: string): Promise<void> {
    await this.request<void>(
      `/rest/config/folders/${encodeURIComponent(folderId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ label }),
      },
    );
    const updated = await this.getFolder(folderId);
    if (updated.label !== label) {
      throw new SyncthingApiError("Syncthing did not retain the updated folder label.");
    }
  }

  async removeFolder(folderId: string): Promise<void> {
    await this.request<void>(
      `/rest/config/folders/${encodeURIComponent(folderId)}`,
      { method: "DELETE" },
    );
    const stillConfigured = (await this.getFolders()).some(
      (folder) => folder.id === folderId,
    );
    if (stillConfigured) {
      throw new SyncthingApiError(
        "Syncthing did not remove the managed folder configuration.",
      );
    }
  }

  async createFolder(
    id: string,
    label: string,
    path: string,
    type: "sendreceive" | "receiveencrypted",
  ): Promise<SyncthingFolder> {
    const template = await this.getDefaultFolder();
    const folder = buildSyncthingFolder(template, id, label, path, type);
    await this.request<void>("/rest/config/folders", {
      method: "POST",
      body: JSON.stringify(folder),
    });
    const created = (await this.getFolders()).find((candidate) => candidate.id === id);
    if (!created) {
      throw new SyncthingApiError("Syncthing did not report the newly created folder.");
    }
    return created;
  }

  async getDevices(): Promise<SyncthingDevice[]> {
    return this.request<SyncthingDevice[]>("/rest/config/devices");
  }

  async ensureDevice(
    deviceId: string,
    name: string,
    untrusted: boolean,
  ): Promise<void> {
    const existing = (await this.getDevices()).find(
      (device) => device.deviceID === deviceId,
    );
    if (existing) {
      if (existing.name !== name || existing.untrusted !== untrusted) {
        await this.request<void>(
          `/rest/config/devices/${encodeURIComponent(deviceId)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ name, untrusted }),
          },
        );
      }
    } else {
      const template = await this.request<SyncthingDevice>(
        "/rest/config/defaults/device",
      );
      await this.request<void>("/rest/config/devices", {
        method: "POST",
        body: JSON.stringify({
          ...template,
          deviceID: deviceId,
          name,
          untrusted,
        }),
      });
    }
    const configured = (await this.getDevices()).find(
      (device) => device.deviceID === deviceId,
    );
    if (!configured || configured.name !== name || configured.untrusted !== untrusted) {
      throw new SyncthingApiError(
        `Syncthing did not retain the configuration for device “${name}”.`,
      );
    }
  }

  async ensureFolderPeer(
    folderId: string,
    deviceId: string,
    encryptionPassword: string,
  ): Promise<void> {
    const folder = await this.getFolder(folderId);
    const existing = folder.devices.find((device) => device.deviceID === deviceId);
    const devices = existing
      ? folder.devices.map((device) =>
          device.deviceID === deviceId
            ? { ...device, encryptionPassword }
            : device,
        )
      : [
          ...folder.devices,
          { deviceID: deviceId, introducedBy: "", encryptionPassword },
        ];
    await this.request<void>(
      `/rest/config/folders/${encodeURIComponent(folderId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ devices }),
      },
    );
    const configured = await this.getFolder(folderId);
    const configuredPeer = configured.devices.find(
      (device) => device.deviceID === deviceId,
    );
    if (
      !configuredPeer ||
      (configuredPeer.encryptionPassword ?? "") !== encryptionPassword
    ) {
      throw new SyncthingApiError(
        "Syncthing did not retain the folder sharing configuration.",
      );
    }
  }

  async removeFolderPeer(folderId: string, deviceId: string): Promise<void> {
    const folder = await this.getFolder(folderId);
    if (!folder.devices.some((device) => device.deviceID === deviceId)) return;
    const devices = folder.devices.filter((device) => device.deviceID !== deviceId);
    await this.request<void>(
      `/rest/config/folders/${encodeURIComponent(folderId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ devices }),
      },
    );
    const configured = await this.getFolder(folderId);
    if (configured.devices.some((device) => device.deviceID === deviceId)) {
      throw new SyncthingApiError(
        "Syncthing did not remove the folder sharing configuration.",
      );
    }
  }

  async getFolderStatus(folderId: string): Promise<SyncthingFolderStatus> {
    return this.request<SyncthingFolderStatus>(
      `/rest/db/status?folder=${encodeURIComponent(folderId)}`,
    );
  }

  async getFolderScanProgress(
    folderId: string,
    scanStartedAt?: string,
  ): Promise<number | undefined> {
    const events = await this.request<SyncthingFolderScanProgressEvent[]>(
      "/rest/events?events=FolderScanProgress&since=0&limit=25&timeout=1",
    );
    return latestFolderScanProgress(events, folderId, scanStartedAt);
  }
}
