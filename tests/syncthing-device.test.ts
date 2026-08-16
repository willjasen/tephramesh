import { describe, expect, it } from "vitest";
import type { SyncthingDevice } from "../src/model";
import { localSyncthingDeviceName } from "../src/syncthing-device";

const devices: SyncthingDevice[] = [
  {
    deviceID: "REMOTE-ID",
    name: "Remote",
    addresses: ["dynamic"],
    untrusted: false,
  },
  {
    deviceID: "LOCAL-ID",
    name: "  Brandon's MacBook Pro  ",
    addresses: ["dynamic"],
    untrusted: false,
  },
];

describe("local Syncthing device discovery", () => {
  it("matches the status device ID and trims its configured name", () => {
    expect(localSyncthingDeviceName(devices, "LOCAL-ID")).toBe(
      "Brandon's MacBook Pro",
    );
  });

  it("does not substitute a different device when local identity is missing", () => {
    expect(localSyncthingDeviceName(devices, "UNKNOWN-ID")).toBeNull();
  });
});
