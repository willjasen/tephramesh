import { describe, expect, it } from "vitest";
import type { SyncthingFolder } from "../src/model";
import {
  buildSyncthingFolder,
  suggestSyncthingFolderPath,
} from "../src/syncthing-folder";

describe("Syncthing folder creation", () => {
  it("preserves Syncthing defaults while applying managed fields", () => {
    const template: SyncthingFolder = {
      id: "",
      label: "",
      path: "~",
      type: "sendreceive",
      paused: true,
      devices: [{ deviceID: "LOCAL-ID" }],
      rescanIntervalS: 3600,
    };

    expect(
      buildSyncthingFolder(
        template,
        "tephramesh-test",
        "Testing",
        "/vault",
        "receiveencrypted",
      ),
    ).toMatchObject({
      id: "tephramesh-test",
      label: "Testing",
      path: "/vault",
      type: "receiveencrypted",
      paused: false,
      rescanIntervalS: 3600,
      devices: [{ deviceID: "LOCAL-ID" }],
    });
  });

  it("suggests a managed path from the instance's default folder", () => {
    const template = {
      id: "",
      label: "",
      path: "~",
      type: "sendreceive",
      devices: [],
    } satisfies SyncthingFolder;
    const folders = [
      { ...template, id: "default", path: "/Users/brandon/Sync" },
    ];
    expect(
      suggestSyncthingFolderPath(folders, template, "tephramesh-1234abcd"),
    ).toBe("/Users/brandon/Sync/tephramesh-1234abcd");
  });

  it("uses an existing managed folder path instead of suggesting a new one", () => {
    const template = {
      id: "",
      label: "",
      path: "~",
      type: "sendreceive",
      devices: [],
    } satisfies SyncthingFolder;
    const folders = [
      { ...template, id: "tephramesh-1234abcd", path: "D:\\Vaults\\Notes" },
    ];
    expect(
      suggestSyncthingFolderPath(folders, template, "tephramesh-1234abcd"),
    ).toBe("D:\\Vaults\\Notes");
  });
});
