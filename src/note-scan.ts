export function notePartialScanPath(rawPath: string): string | undefined {
  const path = rawPath.replaceAll("\\", "/");
  if (path.startsWith("/")) return undefined;
  if (!path || !path.toLowerCase().endsWith(".md")) return undefined;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return path;
}
