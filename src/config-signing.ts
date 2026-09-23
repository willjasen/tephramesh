import type { ConfigHistoryEnvelope } from "./config-history";

export const DEVICE_SIGNING_SECRET_NAME = "tephramesh-device-signing";
const MAX_ENROLLMENTS = 100;
const MAX_ENROLLMENT_CODE_LENGTH = 1024 * 1024;

export interface SigningKeyPairExport {
  keyId: string;
  publicKey: string;
  privateKey: string;
}

export interface DeviceEnrollmentRequest {
  format: "tephramesh-device-enrollment-request-v1";
  bindingId: string;
  deviceId: string;
  keyId: string;
  publicKey: string;
  nonce: string;
  createdAt: string;
}

export interface DeviceEnrollment {
  format: "tephramesh-device-enrollment-v1";
  bindingId: string;
  deviceId: string;
  keyId: string;
  publicKey: string;
  requestNonce: string;
  approvedByKeyId: string;
  createdAt: string;
  signature: string;
}

export interface DeviceEnrollmentApproval {
  format: "tephramesh-device-enrollment-approval-v1";
  rootKeyId: string;
  approvedRevision: number;
  approvedEnvelopeHash: string;
  request: DeviceEnrollmentRequest;
  enrollments: DeviceEnrollment[];
  approvedByKeyId: string;
  signature: string;
}

export interface DeviceEnrollmentCancellation {
  format: "tephramesh-device-enrollment-cancellation-v1";
  rootKeyId: string;
  request: DeviceEnrollmentRequest;
  enrollments: DeviceEnrollment[];
  cancelledByKeyId: string;
  cancelledAt: string;
  signature: string;
}

export interface SignedConfigEnvelope {
  format: "tephramesh-signed-config-v1";
  rootKeyId: string;
  revision: number;
  enrollments: DeviceEnrollment[];
  /** Keys removed from the active enrollment set; certificates remain in history. */
  revokedEnrollmentKeyIds?: string[];
  history: ConfigHistoryEnvelope;
  signerKeyId: string;
  rootTransition?: RootRotationTransition;
  signature: string;
}

export interface RootRotationTransition {
  format: "tephramesh-root-rotation-v1";
  previousRootKeyId: string;
  newRootKeyId: string;
  newRootPublicKey: string;
  newRootEnrollment: DeviceEnrollment;
  previousEnrollments?: DeviceEnrollment[];
  rotatedAt: string;
  signature: string;
}

export interface LocalDeviceSigningRecord extends SigningKeyPairExport {
  format: "tephramesh-local-device-signing-v1";
  bindingId: string;
  deviceId: string;
  rootKeyId?: string;
  rootPublicKey?: string;
  rootPrivateKey?: string;
  previousRootKeyIds?: string[];
  pendingRequest?: DeviceEnrollmentRequest;
  pendingApproval?: DeviceEnrollmentApproval;
  lastAcceptedRevision?: number;
  lastAcceptedEnvelopeHash?: string;
  lastAcceptedEnrollmentKeyIds?: string[];
  lastAcceptedRevokedEnrollmentKeyIds?: string[];
}

export interface ConfigAcceptanceAcknowledgement {
  format: "tephramesh-config-acceptance-v1";
  rootKeyId: string;
  revision: number;
  envelopeHash: string;
  signerKeyId: string;
  acceptedAt: string;
  signature: string;
}

export interface ConfigAcceptanceConfirmation {
  format: "tephramesh-config-acceptance-confirmation-v1";
  rootKeyId: string;
  revision: number;
  envelopeHash: string;
  signerKeyId: string;
  observedSignerKeyIds: string[];
  observedAt: string;
  signature: string;
}

export class SignedConfigConflictError extends Error {
  constructor() {
    super("A conflicting signed Tephramesh configuration was rejected.");
    this.name = "SignedConfigConflictError";
  }
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

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid enrollment code.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return base64ToBytes(padded);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot sign a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => {
      const item = record[key];
      if (item === undefined) throw new Error("Cannot sign undefined data.");
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new Error("Cannot sign unsupported data.");
}

async function sha256Bytes(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer),
  );
}

export async function sha256Canonical(value: unknown): Promise<string> {
  return Array.from(
    await sha256Bytes(new TextEncoder().encode(canonicalJson(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function generateSigningKeyPair(): Promise<SigningKeyPairExport> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    privateKey: bytesToBase64(privateKey),
    publicKey: bytesToBase64(publicKey),
    keyId: Array.from(await sha256Bytes(publicKey), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

async function signValue(value: unknown, privateKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    base64ToBytes(privateKey).buffer as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(canonicalJson(value)).buffer as ArrayBuffer,
  );
  return bytesToBase64(new Uint8Array(signature));
}

async function verifyValue(
  value: unknown,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      base64ToBytes(publicKey).buffer as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64ToBytes(signature).buffer as ArrayBuffer,
      new TextEncoder().encode(canonicalJson(value)).buffer as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

/** Sign application data with an enrolled installation's existing P-256 key. */
export async function signCanonicalValue(
  value: unknown,
  signer: LocalDeviceSigningRecord,
): Promise<string> {
  await assertSigningKeyPair(signer);
  return signValue(value, signer.privateKey);
}

/** Verify application data without exposing key import details to callers. */
export async function verifyCanonicalValue(
  value: unknown,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  return verifyValue(value, signature, publicKey);
}

async function assertSigningKeyPair(keys: SigningKeyPairExport): Promise<void> {
  if (await signingKeyId(keys.publicKey) !== keys.keyId) {
    throw new Error("The local signing public key has the wrong identifier.");
  }
  const challenge = {
    format: "tephramesh-signing-key-check-v1",
    keyId: keys.keyId,
  };
  const signature = await signValue(challenge, keys.privateKey);
  if (!(await verifyValue(challenge, signature, keys.publicKey))) {
    throw new Error("The local signing private key does not match its public key.");
  }
}

function configAcceptancePayload(
  acknowledgement: ConfigAcceptanceAcknowledgement,
): Omit<ConfigAcceptanceAcknowledgement, "signature"> {
  const { signature: _signature, ...payload } = acknowledgement;
  return payload;
}

export async function createConfigAcceptanceAcknowledgement(
  rootKeyId: string,
  revision: number,
  envelopeHash: string,
  signer: LocalDeviceSigningRecord,
): Promise<ConfigAcceptanceAcknowledgement> {
  if (!signer.rootKeyId || signer.rootKeyId !== rootKeyId) {
    throw new Error("This installation cannot acknowledge a different signing root.");
  }
  await assertSigningKeyPair(signer);
  const payload = {
    format: "tephramesh-config-acceptance-v1" as const,
    rootKeyId,
    revision,
    envelopeHash,
    signerKeyId: signer.keyId,
    acceptedAt: new Date().toISOString(),
  };
  return { ...payload, signature: await signValue(payload, signer.privateKey) };
}

export async function verifyConfigAcceptanceAcknowledgement(
  value: unknown,
  rootKeyId: string,
  revision: number,
  envelopeHash: string,
  enrollments: DeviceEnrollment[],
  revokedEnrollmentKeyIds: string[],
): Promise<ConfigAcceptanceAcknowledgement> {
  if (!value || typeof value !== "object") throw new Error("The configuration acknowledgement is invalid.");
  const candidate = value as Partial<ConfigAcceptanceAcknowledgement>;
  if (candidate.format !== "tephramesh-config-acceptance-v1" ||
      candidate.rootKeyId !== rootKeyId || candidate.revision !== revision ||
      candidate.envelopeHash !== envelopeHash || typeof candidate.signerKeyId !== "string" ||
      typeof candidate.acceptedAt !== "string" || !Number.isFinite(Date.parse(candidate.acceptedAt)) ||
      typeof candidate.signature !== "string") {
    throw new Error("The configuration acknowledgement does not match the current signed configuration.");
  }
  await verifyEnrollmentChain(enrollments, rootKeyId);
  const revoked = new Set(revokedEnrollmentKeyIds);
  const signer = enrollments.find((enrollment) => enrollment.keyId === candidate.signerKeyId);
  if (!signer || revoked.has(signer.keyId) || !(await verifyValue(
    configAcceptancePayload(candidate as ConfigAcceptanceAcknowledgement),
    candidate.signature,
    signer.publicKey,
  ))) {
    throw new Error("The configuration acknowledgement signature is invalid.");
  }
  return candidate as ConfigAcceptanceAcknowledgement;
}

function configAcceptanceConfirmationPayload(
  confirmation: ConfigAcceptanceConfirmation,
): Omit<ConfigAcceptanceConfirmation, "signature"> {
  const { signature: _signature, ...payload } = confirmation;
  return payload;
}

export async function createConfigAcceptanceConfirmation(
  rootKeyId: string,
  revision: number,
  envelopeHash: string,
  observedSignerKeyIds: string[],
  signer: LocalDeviceSigningRecord,
): Promise<ConfigAcceptanceConfirmation> {
  if (!signer.rootKeyId || signer.rootKeyId !== rootKeyId) {
    throw new Error("This installation cannot confirm a different signing root.");
  }
  await assertSigningKeyPair(signer);
  const payload = {
    format: "tephramesh-config-acceptance-confirmation-v1" as const,
    rootKeyId,
    revision,
    envelopeHash,
    signerKeyId: signer.keyId,
    observedSignerKeyIds: [...new Set(observedSignerKeyIds)].sort(),
    observedAt: new Date().toISOString(),
  };
  return { ...payload, signature: await signValue(payload, signer.privateKey) };
}

export async function verifyConfigAcceptanceConfirmation(
  value: unknown,
  rootKeyId: string,
  revision: number,
  envelopeHash: string,
  enrollments: DeviceEnrollment[],
  revokedEnrollmentKeyIds: string[],
): Promise<ConfigAcceptanceConfirmation> {
  if (!value || typeof value !== "object") throw new Error("The configuration acceptance confirmation is invalid.");
  const candidate = value as Partial<ConfigAcceptanceConfirmation>;
  const activeKeyIds = new Set(enrollments
    .filter((enrollment) => !revokedEnrollmentKeyIds.includes(enrollment.keyId))
    .map((enrollment) => enrollment.keyId));
  if (candidate.format !== "tephramesh-config-acceptance-confirmation-v1" ||
      candidate.rootKeyId !== rootKeyId || candidate.revision !== revision ||
      candidate.envelopeHash !== envelopeHash || typeof candidate.signerKeyId !== "string" ||
      !Array.isArray(candidate.observedSignerKeyIds) ||
      candidate.observedSignerKeyIds.some((keyId) => typeof keyId !== "string" || !activeKeyIds.has(keyId)) ||
      new Set(candidate.observedSignerKeyIds).size !== candidate.observedSignerKeyIds.length ||
      [...candidate.observedSignerKeyIds].sort().some((keyId, index) => keyId !== candidate.observedSignerKeyIds![index]) ||
      typeof candidate.observedAt !== "string" || !Number.isFinite(Date.parse(candidate.observedAt)) ||
      typeof candidate.signature !== "string") {
    throw new Error("The acceptance confirmation does not match the current signed configuration.");
  }
  await verifyEnrollmentChain(enrollments, rootKeyId);
  const signer = enrollments.find((enrollment) => enrollment.keyId === candidate.signerKeyId);
  if (!signer || !activeKeyIds.has(signer.keyId) || !(await verifyValue(
    configAcceptanceConfirmationPayload(candidate as ConfigAcceptanceConfirmation),
    candidate.signature,
    signer.publicKey,
  ))) {
    throw new Error("The acceptance confirmation signature is invalid.");
  }
  return candidate as ConfigAcceptanceConfirmation;
}

function enrollmentPayload(enrollment: DeviceEnrollment): Omit<DeviceEnrollment, "signature"> {
  const { signature: _signature, ...payload } = enrollment;
  return payload;
}

export async function createGenesisEnrollment(
  bindingId: string,
  deviceId: string,
  keys: SigningKeyPairExport,
): Promise<DeviceEnrollment> {
  await assertSigningKeyPair(keys);
  const unsigned = {
    format: "tephramesh-device-enrollment-v1" as const,
    bindingId,
    deviceId,
    keyId: keys.keyId,
    publicKey: keys.publicKey,
    requestNonce: "genesis",
    approvedByKeyId: keys.keyId,
    createdAt: new Date().toISOString(),
  };
  return { ...unsigned, signature: await signValue(unsigned, keys.privateKey) };
}

export function createEnrollmentRequest(
  bindingId: string,
  deviceId: string,
  keys: SigningKeyPairExport,
): DeviceEnrollmentRequest {
  return {
    format: "tephramesh-device-enrollment-request-v1",
    bindingId,
    deviceId,
    keyId: keys.keyId,
    publicKey: keys.publicKey,
    nonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24))),
    createdAt: new Date().toISOString(),
  };
}

export async function approveEnrollmentRequest(
  request: DeviceEnrollmentRequest,
  approver: LocalDeviceSigningRecord,
): Promise<DeviceEnrollment> {
  validateEnrollmentRequest(request);
  if (!approver.rootKeyId) throw new Error("This installation is not enrolled.");
  await assertSigningKeyPair(approver);
  const unsigned = {
    format: "tephramesh-device-enrollment-v1" as const,
    bindingId: request.bindingId,
    deviceId: request.deviceId,
    keyId: request.keyId,
    publicKey: request.publicKey,
    requestNonce: request.nonce,
    approvedByKeyId: approver.keyId,
    createdAt: new Date().toISOString(),
  };
  return { ...unsigned, signature: await signValue(unsigned, approver.privateKey) };
}

function enrollmentApprovalPayload(
  approval: DeviceEnrollmentApproval,
): Omit<DeviceEnrollmentApproval, "signature"> {
  const { signature: _signature, ...payload } = approval;
  return payload;
}

function enrollmentCancellationPayload(
  cancellation: DeviceEnrollmentCancellation,
): Omit<DeviceEnrollmentCancellation, "signature"> {
  const { signature: _signature, ...payload } = cancellation;
  return payload;
}

export async function createEnrollmentCancellation(
  rootKeyId: string,
  request: DeviceEnrollmentRequest,
  enrollments: DeviceEnrollment[],
  approver: LocalDeviceSigningRecord,
): Promise<DeviceEnrollmentCancellation> {
  validateEnrollmentRequest(request);
  await verifyEnrollmentChain(enrollments, rootKeyId);
  await assertSigningKeyPair(approver);
  const signer = enrollments.find((enrollment) => enrollment.keyId === approver.keyId);
  if (approver.rootKeyId !== rootKeyId || !signer || signer.publicKey !== approver.publicKey) {
    throw new Error("This installation cannot cancel that enrollment request.");
  }
  const unsigned = {
    format: "tephramesh-device-enrollment-cancellation-v1" as const,
    rootKeyId,
    request: structuredClone(request),
    enrollments: structuredClone(enrollments),
    cancelledByKeyId: approver.keyId,
    cancelledAt: new Date().toISOString(),
  };
  return { ...unsigned, signature: await signValue(unsigned, approver.privateKey) };
}

export async function createEnrollmentApproval(
  rootKeyId: string,
  approvedRevision: number,
  approvedEnvelopeHash: string,
  request: DeviceEnrollmentRequest,
  enrollments: DeviceEnrollment[],
  approver: LocalDeviceSigningRecord,
): Promise<DeviceEnrollmentApproval> {
  validateEnrollmentRequest(request);
  await verifyEnrollmentChain(enrollments, rootKeyId);
  await assertSigningKeyPair(approver);
  const approverEnrollment = enrollments.find(
    (enrollment) => enrollment.keyId === approver.keyId,
  );
  if (approver.rootKeyId !== rootKeyId ||
      !approverEnrollment || approverEnrollment.publicKey !== approver.publicKey) {
    throw new Error("This installation cannot sign that enrollment approval.");
  }
  assertRequestEnrollment(request, enrollments);
  const unsigned = {
    format: "tephramesh-device-enrollment-approval-v1" as const,
    rootKeyId,
    approvedRevision,
    approvedEnvelopeHash,
    request: structuredClone(request),
    enrollments: structuredClone(enrollments),
    approvedByKeyId: approver.keyId,
  };
  return { ...unsigned, signature: await signValue(unsigned, approver.privateKey) };
}

export async function verifyEnrollmentChain(
  enrollments: DeviceEnrollment[],
  rootKeyId: string,
): Promise<void> {
  if (!rootKeyId || enrollments.length < 1 || enrollments.length > MAX_ENROLLMENTS) {
    throw new Error("The device enrollment chain is invalid.");
  }
  const byKey = new Map<string, DeviceEnrollment>();
  for (const enrollment of enrollments) {
    validateEnrollment(enrollment);
    if (byKey.has(enrollment.keyId)) {
      throw new Error("The device enrollment chain contains duplicates.");
    }
    if (await signingKeyId(enrollment.publicKey) !== enrollment.keyId) {
      throw new Error("A device enrollment public key has the wrong identifier.");
    }
    byKey.set(enrollment.keyId, enrollment);
  }
  const root = byKey.get(rootKeyId);
  if (!root || root.approvedByKeyId !== root.keyId ||
      !(await verifyValue(enrollmentPayload(root), root.signature, root.publicKey))) {
    throw new Error("The device enrollment root is invalid.");
  }
  const verified = new Set<string>([rootKeyId]);
  while (verified.size < enrollments.length) {
    let advanced = false;
    for (const enrollment of enrollments) {
      if (verified.has(enrollment.keyId)) continue;
      const approver = byKey.get(enrollment.approvedByKeyId);
      if (!approver || !verified.has(approver.keyId)) continue;
      if (!(await verifyValue(
        enrollmentPayload(enrollment),
        enrollment.signature,
        approver.publicKey,
      ))) {
        throw new Error("A device enrollment signature is invalid.");
      }
      verified.add(enrollment.keyId);
      advanced = true;
    }
    if (!advanced) throw new Error("The device enrollment chain is incomplete.");
  }
}

function signedEnvelopePayload(
  envelope: SignedConfigEnvelope,
): Omit<SignedConfigEnvelope, "signature"> {
  const { signature: _signature, ...payload } = envelope;
  return payload;
}

function rootTransitionPayload(
  transition: RootRotationTransition,
): Omit<RootRotationTransition, "signature"> {
  const { signature: _signature, ...payload } = transition;
  return payload;
}

/** Create a root transition without creating another local secret record. */
export async function createRootRotationTransition(
  previousRootKeyId: string,
  newRoot: SigningKeyPairExport,
  oldRootSigner: LocalDeviceSigningRecord,
  rootBindingId: string,
  rootDeviceId: string,
  previousEnrollments: DeviceEnrollment[],
): Promise<RootRotationTransition> {
  if (oldRootSigner.keyId !== previousRootKeyId) {
    throw new Error("Only the current enrollment-root installation can rotate the root.");
  }
  await assertSigningKeyPair(oldRootSigner);
  await assertSigningKeyPair(newRoot);
  const newRootEnrollment = await createGenesisEnrollment(
    rootBindingId,
    rootDeviceId,
    newRoot,
  );
  const unsigned = {
    format: "tephramesh-root-rotation-v1" as const,
    previousRootKeyId,
    newRootKeyId: newRoot.keyId,
    newRootPublicKey: newRoot.publicKey,
    newRootEnrollment,
    previousEnrollments: structuredClone(previousEnrollments),
    rotatedAt: new Date().toISOString(),
  };
  return { ...unsigned, signature: await signValue(unsigned, oldRootSigner.privateKey) };
}

export async function reissueEnrollmentsForRotatedRoot(
  previousEnrollments: DeviceEnrollment[],
  newRoot: SigningKeyPairExport,
  rootBindingId?: string,
  rootDeviceId?: string,
): Promise<DeviceEnrollment[]> {
  const root = await createGenesisEnrollment(
    rootBindingId ??
      previousEnrollments.find((enrollment) => enrollment.approvedByKeyId === enrollment.keyId)?.bindingId ?? "",
    rootDeviceId ??
      previousEnrollments.find((enrollment) => enrollment.approvedByKeyId === enrollment.keyId)?.deviceId ?? "",
    newRoot,
  );
  const reissued = [root];
  for (const enrollment of previousEnrollments) {
    if (enrollment.keyId === newRoot.keyId) continue;
    const unsigned = {
      format: "tephramesh-device-enrollment-v1" as const,
      bindingId: enrollment.bindingId,
      deviceId: enrollment.deviceId,
      keyId: enrollment.keyId,
      publicKey: enrollment.publicKey,
      requestNonce: enrollment.requestNonce,
      approvedByKeyId: newRoot.keyId,
      createdAt: new Date().toISOString(),
    };
    reissued.push({
      ...unsigned,
      signature: await signValue(unsigned, newRoot.privateKey),
    });
  }
  return reissued;
}

async function verifyRootRotationTransition(
  transition: RootRotationTransition,
  _previousEnrollments: DeviceEnrollment[],
): Promise<void> {
  if (transition.format !== "tephramesh-root-rotation-v1" ||
      !transition.previousRootKeyId || !transition.newRootKeyId ||
      transition.previousRootKeyId === transition.newRootKeyId ||
      typeof transition.newRootPublicKey !== "string" ||
      typeof transition.rotatedAt !== "string" ||
      !Number.isFinite(Date.parse(transition.rotatedAt))) {
    throw new Error("The signed enrollment-root transition is invalid.");
  }
  if (transition.previousEnrollments) {
    await verifyEnrollmentChain(transition.previousEnrollments, transition.previousRootKeyId);
    const oldRoot = transition.previousEnrollments.find(
      (enrollment) => enrollment.keyId === transition.previousRootKeyId,
    );
    if (!oldRoot || !(await verifyValue(
      rootTransitionPayload(transition),
      transition.signature,
      oldRoot.publicKey,
    ))) {
      throw new Error("The enrollment-root transition is not signed by the previous root.");
    }
  } else {
    // The first rotation build did not serialize the old enrollment chain.
    // The current envelope cannot reconstruct it after reissuing enrollments,
    // so retain compatibility by requiring the new root proof and the
    // envelope signature, which verifySignedConfigEnvelope performs next.
    void _previousEnrollments;
  }
  const newEnrollment = transition.newRootEnrollment;
  if (newEnrollment.keyId !== transition.newRootKeyId ||
      newEnrollment.publicKey !== transition.newRootPublicKey ||
      newEnrollment.approvedByKeyId !== newEnrollment.keyId ||
      !(await verifyValue(enrollmentPayload(newEnrollment), newEnrollment.signature, newEnrollment.publicKey))) {
    throw new Error("The new enrollment root proof is invalid.");
  }
}

export async function createSignedConfigEnvelope(
  history: ConfigHistoryEnvelope,
  enrollments: DeviceEnrollment[],
  rootKeyId: string,
  revision: number,
  signer: LocalDeviceSigningRecord,
  revokedEnrollmentKeyIds: string[] = [],
  rootTransition?: RootRotationTransition,
): Promise<SignedConfigEnvelope> {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("The signed configuration revision is invalid.");
  }
  if (rootTransition) {
    if (rootTransition.newRootKeyId !== rootKeyId) {
      throw new Error("The root transition does not match the signed configuration root.");
    }
    await verifyRootRotationTransition(rootTransition, enrollments);
    await verifyEnrollmentChain(enrollments, rootKeyId);
  } else {
    await verifyEnrollmentChain(enrollments, rootKeyId);
  }
  assertEnrollmentMembership(enrollments, revokedEnrollmentKeyIds);
  await assertSigningKeyPair(signer);
  const signerEnrollment = enrollments.find(
    (enrollment) => enrollment.keyId === signer.keyId,
  );
  if ((!rootTransition && signer.rootKeyId !== rootKeyId) ||
      (rootTransition && signer.rootKeyId !== rootKeyId) ||
      !signerEnrollment || signerEnrollment.publicKey !== signer.publicKey) {
    throw new Error("This installation is not enrolled for configuration signing.");
  }
  const unsigned = {
    format: "tephramesh-signed-config-v1" as const,
    rootKeyId,
    revision,
    enrollments: structuredClone(enrollments),
    revokedEnrollmentKeyIds: [...revokedEnrollmentKeyIds],
    history: structuredClone(history),
    signerKeyId: signer.keyId,
    ...(rootTransition ? { rootTransition: structuredClone(rootTransition) } : {}),
  };
  return { ...unsigned, signature: await signValue(unsigned, signer.privateKey) };
}

export async function verifySignedConfigEnvelope(
  value: unknown,
): Promise<{ envelope: SignedConfigEnvelope; hash: string }> {
  if (!isSignedConfigEnvelope(value)) {
    throw new Error("The signed Tephramesh configuration is invalid.");
  }
  if (value.rootTransition) {
    if (value.rootTransition.newRootKeyId !== value.rootKeyId) {
      throw new Error("The signed root transition does not match the envelope root.");
    }
    await verifyRootRotationTransition(value.rootTransition, value.enrollments);
    if (value.enrollments.some((enrollment) => enrollment.keyId === value.rootKeyId)) {
      await verifyEnrollmentChain(value.enrollments, value.rootKeyId);
    }
  } else {
    await verifyEnrollmentChain(value.enrollments, value.rootKeyId);
  }
  assertEnrollmentMembership(value.enrollments, value.revokedEnrollmentKeyIds ?? []);
  const signer = value.enrollments.find(
    (enrollment) => enrollment.keyId === value.signerKeyId,
  );
  const transitionRoot = value.rootTransition?.newRootEnrollment;
  const signerPublicKey = signer?.publicKey ??
    (transitionRoot?.keyId === value.signerKeyId ? transitionRoot.publicKey : undefined);
  if (!signerPublicKey ||
    !(await verifyValue(
    signedEnvelopePayload(value),
    value.signature,
    signerPublicKey,
  ))) {
    throw new Error("The Tephramesh configuration signature is invalid.");
  }
  return { envelope: structuredClone(value), hash: await sha256Canonical(value) };
}

function assertEnrollmentMembership(
  enrollments: DeviceEnrollment[],
  revokedEnrollmentKeyIds: string[],
): void {
  const active = new Set(enrollments.map((enrollment) => enrollment.keyId));
  const revoked = new Set(revokedEnrollmentKeyIds);
  if (revoked.size !== revokedEnrollmentKeyIds.length ||
      revokedEnrollmentKeyIds.some((keyId) => !keyId || active.has(keyId))) {
    throw new Error("The signed configuration enrollment membership is invalid.");
  }
}

export function assertEnrollmentMembershipAccepted(
  local: LocalDeviceSigningRecord,
  enrollments: DeviceEnrollment[],
  revokedEnrollmentKeyIds: string[] = [],
  rootTransition?: RootRotationTransition,
): void {
  assertEnrollmentMembership(enrollments, revokedEnrollmentKeyIds);
  const previousActive = local.lastAcceptedEnrollmentKeyIds ?? [];
  const previousRevoked = new Set(local.lastAcceptedRevokedEnrollmentKeyIds ?? []);
  const active = new Set(enrollments.map((enrollment) => enrollment.keyId));
  const revoked = new Set(revokedEnrollmentKeyIds);
  for (const keyId of previousActive) {
    const isRotatedRoot = rootTransition?.previousRootKeyId === keyId &&
      active.has(rootTransition.newRootKeyId);
    if (!active.has(keyId) && !revoked.has(keyId) && !isRotatedRoot) {
      throw new Error("The signed configuration omitted an enrolled installation without revoking it.");
    }
  }
  for (const keyId of previousRevoked) {
    if (!revoked.has(keyId)) {
      throw new Error("A revoked enrollment was restored in the signed configuration.");
    }
  }
}

export function revokeEnrollmentKey(
  enrollments: DeviceEnrollment[],
  revokedEnrollmentKeyIds: string[] = [],
  keyId: string,
): { enrollments: DeviceEnrollment[]; revokedEnrollmentKeyIds: string[] } {
  if (!keyId) throw new Error("Select an enrolled installation to revoke.");
  const match = enrollments.find((enrollment) => enrollment.keyId === keyId);
  if (!match) {
    throw new Error("That installation is not currently enrolled for configuration signing.");
  }
  if (match.approvedByKeyId === match.keyId) {
    throw new Error("The enrollment root cannot be revoked from the active signing set.");
  }
  const active = enrollments.filter((enrollment) => enrollment.keyId !== keyId);
  const revoked = [...new Set([...revokedEnrollmentKeyIds, keyId])];
  assertEnrollmentMembership(active, revoked);
  return {
    enrollments: active,
    revokedEnrollmentKeyIds: revoked,
  };
}

export function assertSignedRevisionAccepted(
  local: LocalDeviceSigningRecord,
  revision: number,
  envelopeHash: string,
): void {
  if ((local.lastAcceptedRevision ?? 0) > revision) {
    throw new Error("A rolled-back Tephramesh configuration was rejected.");
  }
  if (local.lastAcceptedRevision === revision &&
      local.lastAcceptedEnvelopeHash &&
      local.lastAcceptedEnvelopeHash !== envelopeHash) {
    throw new SignedConfigConflictError();
  }
}

export function isSignedConfigEnvelope(value: unknown): value is SignedConfigEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SignedConfigEnvelope>;
  return candidate.format === "tephramesh-signed-config-v1" &&
    typeof candidate.rootKeyId === "string" &&
    Number.isSafeInteger(candidate.revision) &&
    (candidate.revision ?? 0) >= 1 &&
    Array.isArray(candidate.enrollments) &&
    (candidate.revokedEnrollmentKeyIds === undefined || Array.isArray(candidate.revokedEnrollmentKeyIds)) &&
    !!candidate.history && typeof candidate.history === "object" &&
    typeof candidate.signerKeyId === "string" &&
    typeof candidate.signature === "string";
}

export function encodeEnrollmentCode(value: DeviceEnrollmentRequest | DeviceEnrollmentApproval | DeviceEnrollmentCancellation): string {
  return bytesToBase64Url(new TextEncoder().encode(canonicalJson(value)));
}

export function decodeEnrollmentCancellation(code: string): DeviceEnrollmentCancellation {
  const value = decodeEnrollmentCode(code);
  if (!value || typeof value !== "object" ||
      (value as { format?: unknown }).format !== "tephramesh-device-enrollment-cancellation-v1") {
    throw new Error("Enter a valid Tephramesh enrollment cancellation.");
  }
  const cancellation = value as DeviceEnrollmentCancellation;
  validateEnrollmentRequest(cancellation.request);
  if (!cancellation.rootKeyId || !Array.isArray(cancellation.enrollments) ||
      !cancellation.cancelledByKeyId || !cancellation.cancelledAt || !cancellation.signature) {
    throw new Error("The Tephramesh enrollment cancellation is invalid.");
  }
  return cancellation;
}

export async function verifyEnrollmentCancellation(
  cancellation: DeviceEnrollmentCancellation,
  pending: LocalDeviceSigningRecord,
): Promise<void> {
  if (!pending.pendingRequest ||
      canonicalJson(pending.pendingRequest) !== canonicalJson(cancellation.request) ||
      cancellation.request.keyId !== pending.keyId ||
      cancellation.request.publicKey !== pending.publicKey) {
    throw new Error("This cancellation does not match this installation's request.");
  }
  await verifyEnrollmentChain(cancellation.enrollments, cancellation.rootKeyId);
  const signer = cancellation.enrollments.find(
    (candidate) => candidate.keyId === cancellation.cancelledByKeyId,
  );
  if (!signer || !(await verifyValue(
    enrollmentCancellationPayload(cancellation),
    cancellation.signature,
    signer.publicKey,
  ))) {
    throw new Error("The enrollment cancellation signature is invalid.");
  }
}

export function decodeEnrollmentRequest(code: string): DeviceEnrollmentRequest {
  const value = decodeEnrollmentCode(code);
  validateEnrollmentRequest(value);
  return value;
}

export function decodeEnrollmentApproval(code: string): DeviceEnrollmentApproval {
  const value = decodeEnrollmentCode(code);
  if (!value || typeof value !== "object" ||
      (value as { format?: unknown }).format !== "tephramesh-device-enrollment-approval-v1") {
    throw new Error("Enter a valid Tephramesh enrollment approval.");
  }
  const approval = value as DeviceEnrollmentApproval;
  validateEnrollmentRequest(approval.request);
  if (!approval.rootKeyId || !Number.isSafeInteger(approval.approvedRevision) ||
      approval.approvedRevision < 1 || !approval.approvedEnvelopeHash ||
      !Array.isArray(approval.enrollments) || !approval.approvedByKeyId ||
      !approval.signature) {
    throw new Error("The Tephramesh enrollment approval is invalid.");
  }
  return approval;
}

export async function verifyEnrollmentApproval(
  approval: DeviceEnrollmentApproval,
  pending: LocalDeviceSigningRecord,
): Promise<void> {
  if (!pending.pendingRequest ||
      canonicalJson(pending.pendingRequest) !== canonicalJson(approval.request) ||
      approval.request.keyId !== pending.keyId ||
      approval.request.publicKey !== pending.publicKey) {
    throw new Error("This approval does not match this installation's request.");
  }
  await verifyEnrollmentChain(approval.enrollments, approval.rootKeyId);
  const approver = approval.enrollments.find(
    (candidate) => candidate.keyId === approval.approvedByKeyId,
  );
  if (!approver || !(await verifyValue(
    enrollmentApprovalPayload(approval),
    approval.signature,
    approver.publicKey,
  ))) {
    throw new Error("The enrollment approval signature is invalid.");
  }
  const enrollment = approval.enrollments.find(
    (candidate) => candidate.keyId === pending.keyId,
  );
  if (!enrollment || enrollment.requestNonce !== pending.pendingRequest.nonce) {
    throw new Error("The approval does not enroll this installation's signing key.");
  }
  assertRequestEnrollment(approval.request, approval.enrollments);
}

export function applyEnrollmentApprovalToLocalSigningRecord(
  pending: LocalDeviceSigningRecord,
  approval: DeviceEnrollmentApproval,
): LocalDeviceSigningRecord {
  if (!pending.pendingRequest ||
      canonicalJson(pending.pendingRequest) !== canonicalJson(approval.request) ||
      approval.request.keyId !== pending.keyId ||
      approval.request.publicKey !== pending.publicKey) {
    throw new Error("This approval does not match this installation's request.");
  }
  return {
    ...pending,
    rootKeyId: approval.rootKeyId,
    pendingRequest: undefined,
    pendingApproval: approval,
    lastAcceptedRevision: approval.approvedRevision,
    lastAcceptedEnvelopeHash: approval.approvedEnvelopeHash,
    lastAcceptedEnrollmentKeyIds: approval.enrollments.map((enrollment) => enrollment.keyId),
    lastAcceptedRevokedEnrollmentKeyIds: [],
  };
}

function assertRequestEnrollment(
  request: DeviceEnrollmentRequest,
  enrollments: DeviceEnrollment[],
): void {
  const enrollment = enrollments.find(
    (candidate) => candidate.keyId === request.keyId,
  );
  if (!enrollment || enrollment.bindingId !== request.bindingId ||
      enrollment.deviceId !== request.deviceId ||
      enrollment.publicKey !== request.publicKey ||
      enrollment.requestNonce !== request.nonce) {
    throw new Error("The approval does not contain the requested device enrollment.");
  }
}

function decodeEnrollmentCode(code: string): unknown {
  const normalized = code.trim();
  if (!normalized || normalized.length > MAX_ENROLLMENT_CODE_LENGTH) {
    throw new Error("The enrollment code is empty or too large.");
  }
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(normalized)));
  } catch {
    throw new Error("Enter a valid Tephramesh enrollment code.");
  }
}

function validateEnrollmentRequest(value: unknown): asserts value is DeviceEnrollmentRequest {
  if (!value || typeof value !== "object") {
    throw new Error("The device enrollment request is invalid.");
  }
  const request = value as Partial<DeviceEnrollmentRequest>;
  if (request.format !== "tephramesh-device-enrollment-request-v1" ||
      !request.bindingId || !request.deviceId || !request.keyId ||
      !request.publicKey || !request.nonce || !request.createdAt) {
    throw new Error("The device enrollment request is invalid.");
  }
}

function validateEnrollment(value: unknown): asserts value is DeviceEnrollment {
  if (!value || typeof value !== "object") {
    throw new Error("The device enrollment is invalid.");
  }
  const enrollment = value as Partial<DeviceEnrollment>;
  if (enrollment.format !== "tephramesh-device-enrollment-v1" ||
      !enrollment.bindingId || !enrollment.deviceId || !enrollment.keyId ||
      !enrollment.publicKey || !enrollment.requestNonce ||
      !enrollment.approvedByKeyId || !enrollment.createdAt ||
      !enrollment.signature) {
    throw new Error("The device enrollment is invalid.");
  }
}

async function signingKeyId(publicKey: string): Promise<string> {
  return Array.from(await sha256Bytes(base64ToBytes(publicKey)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
