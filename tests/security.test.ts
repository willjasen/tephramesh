import { describe, expect, it } from "vitest";
import {
  endpointUrl,
  generateSyncthingFolderId,
  generateShardPassword,
  isLoopbackHostname,
  normalizeEndpointPath,
  parseEndpointUrl,
  sha256Hex,
  shortDeviceId,
  validateEndpoint,
  validateShardPassword,
} from "../src/security";

describe("endpoint security", () => {
  it("recognizes loopback hosts without accepting lookalikes", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("localhost.example.com")).toBe(false);
    expect(isLoopbackHostname("127.0.0.2")).toBe(false);
  });

  it("locks onboarding to loopback and remote access to HTTPS", () => {
    expect(
      validateEndpoint(
        { protocol: "http", hostname: "localhost", port: 8384 },
        { onboarding: true },
      ),
    ).toBeNull();
    expect(
      validateEndpoint(
        { protocol: "https", hostname: "sync.example.com", port: 8384 },
        { onboarding: true },
      ),
    ).toMatch(/first instance/i);
    expect(
      validateEndpoint(
        { protocol: "http", hostname: "sync.example.com", port: 8384 },
        { onboarding: false },
      ),
    ).toMatch(/HTTPS/);
  });

  it("formats IPv6 endpoints", () => {
    expect(endpointUrl({ protocol: "http", hostname: "::1", port: 8384 })).toBe(
      "http://[::1]:8384",
    );
  });

  it("parses and formats a reverse-proxied Syncthing URL", () => {
    const endpoint = parseEndpointUrl(
      "https://wax.seedhost.eu/overgrownbobcat/syncthing/",
    );
    expect(endpoint).toEqual({
      protocol: "https",
      hostname: "wax.seedhost.eu",
      port: 443,
      path: "/overgrownbobcat/syncthing",
    });
    expect(endpointUrl(endpoint)).toBe(
      "https://wax.seedhost.eu:443/overgrownbobcat/syncthing",
    );
  });

  it("normalizes URL paths and rejects credentials, queries, and fragments", () => {
    expect(normalizeEndpointPath("//syncthing///")).toBe("/syncthing");
    expect(() => parseEndpointUrl("https://user:secret@example.com/syncthing")).toThrow(
      /credentials/i,
    );
    expect(() => parseEndpointUrl("https://example.com/syncthing?key=value")).toThrow(
      /query/i,
    );
    expect(() => parseEndpointUrl("https://example.com/syncthing#section")).toThrow(
      /fragment/i,
    );
  });
});

describe("shard encryption keys", () => {
  it("generates an sk- prefix followed by exactly 32 alphanumeric characters", () => {
    for (let index = 0; index < 25; index += 1) {
      const password = generateShardPassword();
      expect(password).toMatch(/^sk-[A-Za-z0-9]{32}$/);
      expect(validateShardPassword(password)).toBeNull();
    }
  });

  it("rejects the wrong size and punctuation", () => {
    expect(validateShardPassword(`sk-${"a".repeat(31)}`)).not.toBeNull();
    expect(validateShardPassword(`sk-${"a".repeat(31)}-`)).not.toBeNull();
  });

  it("creates a lowercase SHA-256 fingerprint", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("generated identifiers", () => {
  it("generates a namespaced Syncthing folder ID", () => {
    expect(generateSyncthingFolderId()).toMatch(/^tephramesh-[a-z0-9]{8}$/);
  });

  it("shows only Syncthing's first seven-character device ID segment", () => {
    expect(shortDeviceId("ABCDEFG-HIJKLMN-OPQRSTU")).toBe("ABCDEFG");
    expect(shortDeviceId("ABCDEFGHIJK")).toBe("ABCDEFG");
  });
});
