import type { TephrameshProtectedData } from "./secret-bundle";
import { Decrypter, Encrypter } from "age-encryption";

export const DEFAULT_CONFIG_HISTORY_VERSIONS = 10;
export const MIN_CONFIG_HISTORY_VERSIONS = 1;
export const MAX_CONFIG_HISTORY_VERSIONS = 10;

export interface ConfigHistoryBlock {
  version: number;
  previousHash: string | null;
  configHash: string;
  hash: string;
  savedAt: string;
  config: TephrameshProtectedData;
}

export interface ConfigHistoryEnvelope {
  format: "tephramesh-config-history-v1";
  retention: number;
  blocks: ConfigHistoryBlock[];
}

export function normalizeConfigHistoryVersions(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CONFIG_HISTORY_VERSIONS;
  return Math.min(MAX_CONFIG_HISTORY_VERSIONS, Math.max(MIN_CONFIG_HISTORY_VERSIONS, Math.floor(number)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function configBlockHash(
  version: number,
  previousHash: string | null,
  configHash: string,
  savedAt: string,
): Promise<string> {
  return sha256Hex(JSON.stringify({ version, previousHash, configHash, savedAt }));
}

export async function createConfigHistoryBlock(
  config: TephrameshProtectedData,
  previous?: ConfigHistoryBlock,
): Promise<ConfigHistoryBlock> {
  const snapshot = structuredClone(config);
  const version = (previous?.version ?? 0) + 1;
  const previousHash = previous?.hash ?? null;
  const configHash = await sha256Hex(JSON.stringify(snapshot));
  const savedAt = new Date().toISOString();
  const hash = await configBlockHash(version, previousHash, configHash, savedAt);
  return { version, previousHash, configHash, hash, savedAt, config: snapshot };
}

export async function verifyConfigHistory(blocks: ConfigHistoryBlock[]): Promise<void> {
  if (blocks.length === 0) throw new Error("The Tephramesh configuration history has no versions.");
  const first = blocks[0]!;
  let previousHash = first.previousHash;
  let previousVersion = first.version - 1;
  for (const block of blocks) {
    if (!Number.isInteger(block.version) || block.version <= previousVersion || block.previousHash !== previousHash) {
      throw new Error("The Tephramesh configuration history is not a valid chain.");
    }
    const configHash = await sha256Hex(JSON.stringify(block.config));
    const hash = await configBlockHash(block.version, block.previousHash, configHash, block.savedAt);
    if (block.configHash !== configHash || block.hash !== hash) {
      throw new Error("The Tephramesh configuration history failed integrity verification.");
    }
    previousHash = block.hash;
    previousVersion = block.version;
  }
}

/**
 * Repairs snapshots affected by the historical in-memory aliasing bug. This is
 * intentionally narrower than normal verification: every stored link and block
 * hash must still authenticate its original metadata. Only config hashes and
 * the links that follow their rebuilt block hashes may change.
 */
export async function repairAliasedConfigHistory(
  blocks: ConfigHistoryBlock[],
): Promise<ConfigHistoryBlock[]> {
  if (blocks.length === 0) throw new Error("The Tephramesh configuration history has no versions.");
  let expectedStoredPreviousHash = blocks[0]!.previousHash;
  let previousVersion = blocks[0]!.version - 1;
  for (const block of blocks) {
    if (
      !Number.isInteger(block.version) ||
      block.version <= previousVersion ||
      block.previousHash !== expectedStoredPreviousHash
    ) {
      throw new Error("The Tephramesh configuration history is not a valid chain.");
    }
    const storedHash = await configBlockHash(
      block.version,
      block.previousHash,
      block.configHash,
      block.savedAt,
    );
    if (storedHash !== block.hash) {
      throw new Error("The Tephramesh configuration history failed integrity verification.");
    }
    expectedStoredPreviousHash = block.hash;
    previousVersion = block.version;
  }

  let rebuiltPreviousHash = blocks[0]!.previousHash;
  const repaired: ConfigHistoryBlock[] = [];
  for (const block of blocks) {
    const configHash = await sha256Hex(JSON.stringify(block.config));
    const hash = await configBlockHash(
      block.version,
      rebuiltPreviousHash,
      configHash,
      block.savedAt,
    );
    repaired.push({
      ...structuredClone(block),
      previousHash: rebuiltPreviousHash,
      configHash,
      hash,
    });
    rebuiltPreviousHash = hash;
  }
  await verifyConfigHistory(repaired);
  return repaired;
}

export function isConfigHistoryEnvelope(value: unknown): value is ConfigHistoryEnvelope {
  return !!value && typeof value === "object" &&
    (value as { format?: unknown }).format === "tephramesh-config-history-v1" &&
    Array.isArray((value as { blocks?: unknown }).blocks);
}

export async function encryptConfigHistory(recipient: string, history: unknown): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient.trim());
  const bytes = await encrypter.encrypt(JSON.stringify(history));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function decryptConfigHistory(identity: string, ciphertext: string): Promise<unknown> {
  const binary = atob(ciphertext);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity.trim());
  return JSON.parse(await decrypter.decrypt(bytes, "text"));
}
