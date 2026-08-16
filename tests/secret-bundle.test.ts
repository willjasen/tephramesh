import { generateIdentity, identityToRecipient } from "age-encryption";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decryptSecrets,
  decryptProtectedData,
  emptySecrets,
  encryptSecrets,
  encryptProtectedData,
  generatePostQuantumAgeKeyPair,
  validateAgeKeyPair,
} from "../src/secret-bundle";
import { DEFAULT_SETTINGS } from "../src/model";

describe("age-encrypted secret bundle", () => {
  let identity: string;
  let recipient: string;

  beforeAll(async () => {
    identity = await generateIdentity();
    recipient = await identityToRecipient(identity);
  });

  it("validates a matching native age key pair", async () => {
    await expect(validateAgeKeyPair(recipient, identity)).resolves.toEqual({
      recipient,
      identity,
    });
  });

  it("rejects a private identity for another recipient", async () => {
    const otherIdentity = await generateIdentity();
    await expect(validateAgeKeyPair(recipient, otherIdentity)).rejects.toThrow(
      /does not match/i,
    );
  });

  it("round trips API keys and the shard key without plaintext storage", async () => {
    const secrets = emptySecrets();
    secrets.apiKeys.device = "syncthing-api-key";
    secrets.shardEncryptionKey = `sk-${"a".repeat(32)}`;
    const encrypted = await encryptSecrets(recipient, secrets);

    expect(encrypted).not.toContain("syncthing-api-key");
    await expect(decryptSecrets(identity, encrypted)).resolves.toEqual(secrets);
  });

  it("generates a post-quantum hybrid key pair that encrypts and decrypts", async () => {
    const keys = await generatePostQuantumAgeKeyPair();
    expect(keys.recipient).toMatch(/^age1pq1/);
    expect(keys.identity).toMatch(/^AGE-SECRET-KEY-PQ-1/);
    await expect(validateAgeKeyPair(keys.recipient, keys.identity)).resolves.toEqual(
      keys,
    );
    const encrypted = await encryptSecrets(keys.recipient, emptySecrets());
    await expect(decryptSecrets(keys.identity, encrypted)).resolves.toEqual(
      emptySecrets(),
    );
  });

  it("encrypts all operational settings together with the secrets", async () => {
    const { ageRecipient: _ageRecipient, ...settings } = {
      ...structuredClone(DEFAULT_SETTINGS),
      ageRecipient: recipient,
      onboardingComplete: true,
      folderId: "tephramesh-private",
      folderLabel: "Private vault",
    };
    const protectedData = {
      schemaVersion: 1 as const,
      settings,
      secrets: emptySecrets(),
    };
    const encrypted = await encryptProtectedData(recipient, protectedData);

    expect(encrypted).not.toContain("Private vault");
    await expect(decryptProtectedData(identity, encrypted)).resolves.toEqual(
      protectedData,
    );
  });
});
