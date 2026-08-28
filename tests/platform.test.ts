import { describe, expect, it } from "vitest";
import {
  operatingSystemPresentation,
  supportedOperatingSystem,
} from "../src/platform";

describe("Syncthing operating system presentation", () => {
  it.each([
    ["darwin", "macos", "macOS"],
    ["windows", "windows", "Windows"],
    ["linux", "linux", "Linux"],
  ] as const)("maps %s to its supported platform", (reported, platform, label) => {
    expect(supportedOperatingSystem(reported)).toBe(platform);
    expect(operatingSystemPresentation(reported)?.label).toBe(label);
  });

  it("normalizes API values and hides unsupported platforms", () => {
    expect(supportedOperatingSystem(" Linux ")).toBe("linux");
    expect(operatingSystemPresentation("freebsd")).toBeUndefined();
    expect(operatingSystemPresentation(undefined)).toBeUndefined();
  });
});
