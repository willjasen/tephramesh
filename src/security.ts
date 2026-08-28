import type { Endpoint } from "./model";

const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LOWERCASE_ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateSyncthingFolderId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let suffix = "";
  for (const byte of bytes) {
    suffix += LOWERCASE_ALPHANUMERIC[byte % LOWERCASE_ALPHANUMERIC.length] ?? "";
  }
  return `tephramesh-${suffix}`;
}

export function shortDeviceId(deviceId: string): string {
  return deviceId.split("-", 1)[0]?.slice(0, 7) ?? "";
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function validateEndpoint(
  endpoint: Endpoint,
  options: { onboarding: boolean },
): string | null {
  if (endpoint.protocol !== "http" && endpoint.protocol !== "https") {
    return "The Syncthing URL must use HTTP or HTTPS.";
  }
  const hostname = endpoint.hostname.trim();
  if (!hostname) return "Hostname is required.";
  if (/[@/?#\\%\s]/u.test(hostname)) {
    return "Enter only a hostname, without credentials or other URL syntax.";
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    return "Port must be between 1 and 65535.";
  }

  let parsed: URL;
  try {
    parsed = new URL(endpointUrl(endpoint));
  } catch {
    return "Enter a valid Syncthing URL.";
  }
  if (parsed.username || parsed.password) {
    return "The hostname cannot contain credentials or other URL syntax.";
  }
  const parsedHostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const effectivePort = parsed.port
    ? Number(parsed.port)
    : endpoint.protocol === "https"
      ? 443
      : 80;
  if (effectivePort !== endpoint.port) {
    return "Enter a valid hostname and port.";
  }
  if (parsed.search || parsed.hash) {
    return "The Syncthing URL path cannot contain a query or fragment.";
  }
  const normalizedPath = normalizeEndpointPath(endpoint.path ?? "");
  if (normalizeEndpointPath(parsed.pathname) !== normalizedPath) {
    return "Enter a valid Syncthing URL path.";
  }

  if (options.onboarding && !isLoopbackHostname(parsedHostname)) {
    return "The first instance must use localhost or another loopback address.";
  }
  if (!isLoopbackHostname(parsedHostname) && endpoint.protocol !== "https") {
    return "Remote Syncthing APIs must use HTTPS.";
  }
  return null;
}

export function endpointUrl(endpoint: Endpoint): string {
  const bareHost = endpoint.hostname.trim().replace(/^\[|\]$/g, "");
  const host = bareHost.includes(":") ? `[${bareHost}]` : bareHost;
  return `${endpoint.protocol}://${host}:${endpoint.port}${normalizeEndpointPath(endpoint.path ?? "")}`;
}

export function normalizeEndpointPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return "";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

export function parseEndpointUrl(value: string): Endpoint {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid Syncthing URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The Syncthing URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Do not include credentials in the Syncthing URL.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("The Syncthing URL cannot contain a query or fragment.");
  }
  const protocol = parsed.protocol.slice(0, -1) as Endpoint["protocol"];
  return {
    protocol,
    hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
    port: parsed.port ? Number(parsed.port) : protocol === "https" ? 443 : 80,
    path: normalizeEndpointPath(parsed.pathname),
  };
}

export function generateShardPassword(length = 32): string {
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new Error("Password length must be a positive integer.");
  }
  const rejectionLimit = 256 - (256 % ALPHANUMERIC.length);
  const output: string[] = [];
  while (output.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - output.length + 8));
    for (const byte of bytes) {
      if (byte >= rejectionLimit) continue;
      output.push(ALPHANUMERIC[byte % ALPHANUMERIC.length] ?? "");
      if (output.length === length) break;
    }
  }
  return `sk-${output.join("")}`;
}

export function validateShardPassword(password: string): string | null {
  if (!/^sk-[A-Za-z0-9]{32}$/.test(password)) {
    return "The shard encryption key must start with sk- followed by exactly 32 alphanumeric characters.";
  }
  return null;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
