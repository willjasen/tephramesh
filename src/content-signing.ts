import {
  signCanonicalValue,
  verifyCanonicalValue,
  verifyEnrollmentChain,
  type DeviceEnrollment,
  type LocalDeviceSigningRecord,
} from "./config-signing";

export const CONTENT_SIGNATURE_DIRECTORY = ".tephramesh/signatures";

export interface ContentSignatureRecord {
  format: "tephramesh-content-signature-v1";
  rootKeyId: string;
  path: string;
  contentHash: string;
  byteLength: number;
  signerKeyId: string;
  signedAt: string;
  signature: string;
}

interface ContentChangeTransaction {
  docChanged: boolean;
  isUserEvent(event: string): boolean;
}

const LOCAL_CONTENT_CHANGE_EVENTS = ["input", "delete", "move", "undo", "redo"] as const;

/** Distinguish direct editor actions from external/programmatic document replacement. */
export function hasLocalContentChange(
  transactions: readonly ContentChangeTransaction[],
): boolean {
  return transactions.some((transaction) =>
    transaction.docChanged &&
    LOCAL_CONTENT_CHANGE_EVENTS.some((event) => transaction.isUserEvent(event)),
  );
}

function contentSignaturePayload(
  record: ContentSignatureRecord,
): Omit<ContentSignatureRecord, "signature"> {
  const { signature: _signature, ...payload } = record;
  return payload;
}

export function isContentSignaturePath(path: string): boolean {
  return path === ".tephramesh" || path.startsWith(".tephramesh/");
}

export async function sha256Content(content: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", content);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function contentSignaturePath(path: string, contentHash?: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(contentHash ? `${path}\0${contentHash}` : path).buffer as ArrayBuffer,
  );
  const name = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${CONTENT_SIGNATURE_DIRECTORY}/${name}.json`;
}

export async function createContentSignature(
  path: string,
  content: ArrayBuffer,
  rootKeyId: string,
  signer: LocalDeviceSigningRecord,
): Promise<ContentSignatureRecord> {
  if (!rootKeyId || signer.rootKeyId !== rootKeyId) {
    throw new Error("This installation is not enrolled for content signing.");
  }
  if (!path || isContentSignaturePath(path) || path === ".obsidian" || path.startsWith(".obsidian/")) {
    throw new Error("That vault path cannot be signed.");
  }
  const payload = {
    format: "tephramesh-content-signature-v1" as const,
    rootKeyId,
    path,
    contentHash: await sha256Content(content),
    byteLength: content.byteLength,
    signerKeyId: signer.keyId,
    signedAt: new Date().toISOString(),
  };
  return { ...payload, signature: await signCanonicalValue(payload, signer) };
}

export async function verifyContentSignature(
  value: unknown,
  path: string,
  content: ArrayBuffer,
  rootKeyId: string,
  enrollments: DeviceEnrollment[],
  revokedEnrollmentKeyIds: string[] = [],
): Promise<ContentSignatureRecord> {
  if (!value || typeof value !== "object") throw new Error("The content signature is invalid.");
  const candidate = value as Partial<ContentSignatureRecord>;
  if (candidate.format !== "tephramesh-content-signature-v1" ||
      candidate.rootKeyId !== rootKeyId || candidate.path !== path ||
      typeof candidate.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.contentHash) ||
      !Number.isSafeInteger(candidate.byteLength) || (candidate.byteLength ?? -1) < 0 ||
      typeof candidate.signerKeyId !== "string" ||
      typeof candidate.signedAt !== "string" || !Number.isFinite(Date.parse(candidate.signedAt)) ||
      typeof candidate.signature !== "string") {
    throw new Error("The content signature metadata is invalid.");
  }
  await verifyEnrollmentChain(enrollments, rootKeyId);
  const signer = enrollments.find((entry) => entry.keyId === candidate.signerKeyId);
  if (!signer || revokedEnrollmentKeyIds.includes(signer.keyId) ||
      !(await verifyCanonicalValue(
        contentSignaturePayload(candidate as ContentSignatureRecord),
        candidate.signature,
        signer.publicKey,
      ))) {
    throw new Error("The content signature is not from an active enrolled installation.");
  }
  if (candidate.byteLength !== content.byteLength ||
      candidate.contentHash !== await sha256Content(content)) {
    throw new Error("The file has changed since it was signed.");
  }
  return candidate as ContentSignatureRecord;
}
