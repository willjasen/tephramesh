export interface ConfigJournalRecord {
  format: "tephramesh-config-journal-v1";
  changeId: string;
  revision: number;
  envelopeHash: string;
  signerKeyId: string;
  createdAt: string;
  encryptedData: string;
}

const MAX_JOURNAL_CIPHERTEXT_LENGTH = 64 * 1024 * 1024;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const CHANGE_ID_PATTERN = /^[a-z0-9]+-[0-9a-f]{24}$/;

export function createConfigJournalRecord(
  revision: number,
  envelopeHash: string,
  signerKeyId: string,
  encryptedData: string,
): ConfigJournalRecord {
  const random = crypto.getRandomValues(new Uint8Array(12));
  const changeId = `${Date.now().toString(36)}-${Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return {
    format: "tephramesh-config-journal-v1",
    changeId,
    revision,
    envelopeHash,
    signerKeyId,
    createdAt: new Date().toISOString(),
    encryptedData,
  };
}

export function isConfigJournalRecord(value: unknown): value is ConfigJournalRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConfigJournalRecord>;
  return candidate.format === "tephramesh-config-journal-v1" &&
    typeof candidate.changeId === "string" && CHANGE_ID_PATTERN.test(candidate.changeId) &&
    typeof candidate.revision === "number" && Number.isSafeInteger(candidate.revision) && candidate.revision >= 1 &&
    typeof candidate.envelopeHash === "string" && SHA256_HEX_PATTERN.test(candidate.envelopeHash) &&
    typeof candidate.signerKeyId === "string" && candidate.signerKeyId.length > 0 && candidate.signerKeyId.length <= 256 &&
    typeof candidate.createdAt === "string" && Number.isFinite(Date.parse(candidate.createdAt)) &&
    typeof candidate.encryptedData === "string" && candidate.encryptedData.length > 0 &&
    candidate.encryptedData.length <= MAX_JOURNAL_CIPHERTEXT_LENGTH;
}
