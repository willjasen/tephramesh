import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import {
  createConfigHistoryBlock,
  normalizeConfigHistoryVersions,
  repairAliasedConfigHistory,
  verifyConfigHistory,
} from "../src/config-history";
import { emptySecrets } from "../src/secret-bundle";

const config = {
  schemaVersion: 1 as const,
  settings: (() => {
    const { ageRecipient: _ageRecipient, schemaVersion: _envelopeSchemaVersion, ...settings } = structuredClone(DEFAULT_SETTINGS);
    return settings;
  })(),
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

  it("isolates a saved snapshot from later runtime mutations", async () => {
    const running = structuredClone(config);
    const block = await createConfigHistoryBlock(running);
    running.secrets.shardEncryptionKey = "changed after save";

    expect(block.config.secrets.shardEncryptionKey).toBe("");
    await expect(verifyConfigHistory([block])).resolves.toBeUndefined();
  });

  it("repairs config mutations only when the stored chain metadata remains intact", async () => {
    const first = await createConfigHistoryBlock(config);
    const second = await createConfigHistoryBlock(
      { ...config, secrets: { ...emptySecrets(), shardEncryptionKey: "before" } },
      first,
    );
    second.config.secrets.shardEncryptionKey = "mutated after hashing";

    await expect(verifyConfigHistory([first, second])).rejects.toThrow(/integrity/i);
    const repaired = await repairAliasedConfigHistory([first, second]);
    await expect(verifyConfigHistory(repaired)).resolves.toBeUndefined();
    expect(repaired[1]?.config.secrets.shardEncryptionKey).toBe("mutated after hashing");

    await expect(
      repairAliasedConfigHistory([{ ...first, hash: "tampered" }, second]),
    ).rejects.toThrow(/integrity/i);
  });
});
