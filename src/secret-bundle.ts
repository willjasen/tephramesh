import {
  Decrypter,
  Encrypter,
  generateHybridIdentity,
  identityToRecipient,
} from "age-encryption";
import type { TephrameshSettings } from "./model";

export const AGE_IDENTITY_SECRET_NAME = "tephramesh-age-identity";

export interface TephrameshSecrets {
  schemaVersion: 1;
  apiKeys: Record<string, string>;
  shardEncryptionKey: string;
}

export interface TephrameshProtectedData {
  schemaVersion: 1;
  settings: Omit<TephrameshSettings, "ageRecipient">;
  secrets: TephrameshSecrets;
}

export function emptySecrets(): TephrameshSecrets {
  return { schemaVersion: 1, apiKeys: {}, shardEncryptionKey: "" };
}

export async function generatePostQuantumAgeKeyPair(): Promise<{
  recipient: string;
  identity: string;
}> {
  const identity = await generateHybridIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function validateAgeKeyPair(
  recipient: string,
  identity: string,
): Promise<{ recipient: string; identity: string }> {
  const normalizedRecipient = recipient.trim();
  const normalizedIdentity = identity.trim();
  if (!normalizedRecipient.startsWith("age1")) {
    throw new Error("Enter a native age public recipient beginning with age1.");
  }
  if (
    !normalizedIdentity.startsWith("AGE-SECRET-KEY-1") &&
    !normalizedIdentity.startsWith("AGE-SECRET-KEY-PQ-1")
  ) {
    throw new Error(
      "Enter a matching native age private identity beginning with AGE-SECRET-KEY-1 or AGE-SECRET-KEY-PQ-1.",
    );
  }
  const derivedRecipient = await identityToRecipient(normalizedIdentity);
  if (derivedRecipient !== normalizedRecipient) {
    throw new Error("The age private identity does not match the public recipient.");
  }
  return { recipient: normalizedRecipient, identity: normalizedIdentity };
}

export async function encryptSecrets(
  recipient: string,
  secrets: TephrameshSecrets,
): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient.trim());
  return bytesToBase64(await encrypter.encrypt(JSON.stringify(secrets)));
}

export async function decryptSecrets(
  identity: string,
  ciphertext: string,
): Promise<TephrameshSecrets> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity.trim());
  const plaintext = await decrypter.decrypt(base64ToBytes(ciphertext), "text");
  const parsed = JSON.parse(plaintext) as Partial<TephrameshSecrets>;
  if (
    parsed.schemaVersion !== 1 ||
    !parsed.apiKeys ||
    typeof parsed.apiKeys !== "object" ||
    typeof parsed.shardEncryptionKey !== "string"
  ) {
    throw new Error("The decrypted Tephramesh secret bundle is invalid.");
  }
  return {
    schemaVersion: 1,
    apiKeys: Object.fromEntries(
      Object.entries(parsed.apiKeys).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    shardEncryptionKey: parsed.shardEncryptionKey,
  };
}

export async function encryptProtectedData(
  recipient: string,
  data: TephrameshProtectedData,
): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient.trim());
  return bytesToBase64(await encrypter.encrypt(JSON.stringify(data)));
}

export async function decryptProtectedData(
  identity: string,
  ciphertext: string,
): Promise<TephrameshProtectedData> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity.trim());
  const plaintext = await decrypter.decrypt(base64ToBytes(ciphertext), "text");
  const parsed = JSON.parse(plaintext) as Partial<TephrameshProtectedData>;
  if (
    parsed.schemaVersion !== 1 ||
    !parsed.settings ||
    typeof parsed.settings !== "object" ||
    !parsed.secrets ||
    typeof parsed.secrets !== "object"
  ) {
    throw new Error("The decrypted Tephramesh configuration is invalid.");
  }
  return parsed as TephrameshProtectedData;
}
