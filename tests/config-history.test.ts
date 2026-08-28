import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import {
  createConfigHistoryBlock,
  normalizeConfigHistoryVersions,
  verifyConfigHistory,
} from "../src/config-history";
import { emptySecrets } from "../src/secret-bundle";

const config = {
  schemaVersion: 1 as const,
  settings: { ...structuredClone(DEFAULT_SETTINGS), ageRecipient: undefined } as never,
  secrets: emptySecrets(),
};

describe("encrypted configuration history", () => {
  it("clamps the user-configurable retention count", () => {
    expect(normalizeConfigHistoryVersions(undefined)).toBe(10);
    expect(normalizeConfigHistoryVersions(0)).toBe(1);
    expect(normalizeConfigHistoryVersions(12.9)).toBe(10);
    expect(normalizeConfigHistoryVersions(999)).toBe(10);
  });

  it("creates and verifies a linked history", async () => {
    const first = await createConfigHistoryBlock(config);
    const second = await createConfigHistoryBlock({ ...config, secrets: { ...emptySecrets(), shardEncryptionKey: "changed" } }, first);
    await expect(verifyConfigHistory([first, second])).resolves.toBeUndefined();
    await expect(verifyConfigHistory([{ ...second, configHash: "tampered" },])).rejects.toThrow(/integrity/i);
  });
});
