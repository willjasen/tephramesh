export type SupportedOperatingSystem = "macos" | "windows" | "linux";

export function supportedOperatingSystem(
  syncthingOperatingSystem: string | undefined,
): SupportedOperatingSystem | undefined {
  switch (syncthingOperatingSystem?.trim().toLowerCase()) {
    case "darwin":
    case "macos":
      return "macos";
    case "windows":
      return "windows";
    case "linux":
      return "linux";
    default:
      return undefined;
  }
}

export function operatingSystemPresentation(
  syncthingOperatingSystem: string | undefined,
): { label: string; glyph: string } | undefined {
  switch (supportedOperatingSystem(syncthingOperatingSystem)) {
    case "macos":
      return { label: "macOS", glyph: "" };
    case "windows":
      return { label: "Windows", glyph: "⊞" };
    case "linux":
      return { label: "Linux", glyph: "🐧" };
    default:
      return undefined;
  }
}
