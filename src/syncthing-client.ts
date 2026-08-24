import { requestUrl, type RequestUrlParam } from "obsidian";
import type {
  Endpoint,
  SyncthingDevice,
  SyncthingFolder,
  SyncthingFolderScanProgressEvent,
  SyncthingFolderStatus,
  SyncthingLocalNeed,
  SyncthingRemoteNeed,
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
  private static readonly IGNORE_SECTION_START = "// BEGIN TEPHRAMESH MANAGED RULES";
  private static readonly IGNORE_SECTION_END = "// END TEPHRAMESH MANAGED RULES";
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

  async getPendingDevices(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/rest/cluster/pending/devices");
  }

  async getPendingFolders(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/rest/cluster/pending/folders");
  }

  async getDefaultFolder(): Promise<SyncthingFolder> {
    return this.request<SyncthingFolder>("/rest/config/defaults/folder");
  }

  async getDefaultIgnoreRules(): Promise<string[]> {
    const result = await this.request<{ lines?: unknown }>("/rest/config/defaults/ignores");
    return Array.isArray(result.lines) ? result.lines.filter((line): line is string => typeof line === "string") : [];
  }

  async ensureDefaultIgnoreRules(managedLines: string[]): Promise<void> {
    const existing = await this.getDefaultIgnoreRules();
    const lines = this.withManagedIgnoreSection(existing, managedLines);
    if (JSON.stringify(lines) === JSON.stringify(existing)) return;
    await this.request<void>("/rest/config/defaults/ignores", {
      method: "PUT",
      body: JSON.stringify({ lines }),
    });
    const updated = await this.getDefaultIgnoreRules();
    if (JSON.stringify(updated) !== JSON.stringify(lines)) {
      throw new SyncthingApiError("Syncthing did not retain the managed ignore rules.");
    }
  }

  async ensureFolderIgnoreRules(folderId: string, managedLines: string[]): Promise<void> {
    const current = await this.request<{ ignore?: unknown }>(
      `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`,
    );
    const existing = Array.isArray(current.ignore)
      ? current.ignore.filter((line): line is string => typeof line === "string")
      : [];
    const lines = this.withManagedIgnoreSection(existing, managedLines);
    if (JSON.stringify(lines) === JSON.stringify(existing)) return;
    await this.request<void>(`/rest/db/ignores?folder=${encodeURIComponent(folderId)}`, {
      method: "POST",
      body: JSON.stringify({ ignore: lines }),
    });
    const updated = await this.request<{ ignore?: unknown }>(
      `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`,
    );
    const retained = Array.isArray(updated.ignore) ? updated.ignore : [];
    if (JSON.stringify(retained) !== JSON.stringify(lines)) {
      throw new SyncthingApiError("Syncthing did not retain the managed folder ignore rules.");
    }
  }

  private withManagedIgnoreSection(existing: string[], managedLines: string[]): string[] {
    const start = existing.indexOf(SyncthingClient.IGNORE_SECTION_START);
    const end = start < 0 ? -1 : existing.indexOf(SyncthingClient.IGNORE_SECTION_END, start + 1);
    let withoutSection = start >= 0 && end >= start
      ? [...existing.slice(0, start), ...existing.slice(end + 1)]
      : existing.filter((line) => !/^\/\/ always ignore \(from tephramesh\b/i.test(line.trim()));
    const cleanRules = managedLines.filter((line) => line.trim().length > 0);
    const managedSet = new Set(cleanRules);
    withoutSection = withoutSection.filter((line) => !managedSet.has(line));
    while (withoutSection.at(-1)?.trim() === "") withoutSection.pop();
    if (cleanRules.length === 0) return withoutSection;
    return [
      ...withoutSection,
      ...(withoutSection.length > 0 ? [""] : []),
      SyncthingClient.IGNORE_SECTION_START,
      ...cleanRules,
      SyncthingClient.IGNORE_SECTION_END,
    ];
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

  async updateFolderPullOrder(folderId: string, pullOrder: string): Promise<void> {
    await this.request<void>(`/rest/config/folders/${encodeURIComponent(folderId)}`, {
      method: "PATCH", body: JSON.stringify({ order: pullOrder }),
    });
    const updated = await this.getFolder(folderId);
    if (updated.order !== pullOrder) {
      throw new SyncthingApiError("Syncthing did not retain the managed folder pull order.");
    }
  }

  async setFolderPaused(folderId: string, paused: boolean): Promise<void> {
    await this.request<void>(
      `/rest/config/folders/${encodeURIComponent(folderId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ paused }),
      },
    );
    const updated = await this.getFolder(folderId);
    if (Boolean(updated.paused) !== paused) {
      throw new SyncthingApiError(
        `Syncthing did not ${paused ? "pause" : "resume"} the managed folder.`,
      );
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

  async getRemoteNeededFiles(
    folderId: string,
    deviceId: string,
  ): Promise<string[]> {
    const perPage = 1000;
    const names: string[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.request<SyncthingRemoteNeed>(
        `/rest/db/remoteneed?folder=${encodeURIComponent(folderId)}&device=${encodeURIComponent(deviceId)}&page=${page}&perpage=${perPage}`,
      );
      names.push(...response.files.map((file) => file.name));
      if (response.files.length < perPage) return names;
    }
  }

  async getLocalNeededFiles(folderId: string): Promise<string[]> {
    const perPage = 1000;
    const names: string[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.request<SyncthingLocalNeed>(
        `/rest/db/need?folder=${encodeURIComponent(folderId)}&page=${page}&perpage=${perPage}`,
      );
      const files = [
        ...response.progress,
        ...response.queued,
        ...response.rest,
      ];
      names.push(...files.map((file) => file.name));
      if (files.length < perPage) return names;
    }
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
