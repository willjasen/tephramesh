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

export async function createConfigHistoryBlock(
  config: TephrameshProtectedData,
  previous?: ConfigHistoryBlock,
): Promise<ConfigHistoryBlock> {
  const version = (previous?.version ?? 0) + 1;
  const previousHash = previous?.hash ?? null;
  const configHash = await sha256Hex(JSON.stringify(config));
  const savedAt = new Date().toISOString();
  const hash = await sha256Hex(JSON.stringify({ version, previousHash, configHash, savedAt }));
  return { version, previousHash, configHash, hash, savedAt, config };
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
    const hash = await sha256Hex(JSON.stringify({ version: block.version, previousHash: block.previousHash, configHash, savedAt: block.savedAt }));
    if (block.configHash !== configHash || block.hash !== hash) {
      throw new Error("The Tephramesh configuration history failed integrity verification.");
    }
    previousHash = block.hash;
    previousVersion = block.version;
  }
}

export function isConfigHistoryEnvelope(value: unknown): value is ConfigHistoryEnvelope {
  return !!value && typeof value === "object" &&
    (value as { format?: unknown }).format === "tephramesh-config-history-v1" &&
    Array.isArray((value as { blocks?: unknown }).blocks);
}

export async function encryptConfigHistory(recipient: string, history: ConfigHistoryEnvelope): Promise<string> {
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
