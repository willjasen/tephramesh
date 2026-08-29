import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import {
  createConfigHistoryBlock,
  repairAliasedConfigHistory,
  verifyConfigHistory,
  type ConfigHistoryEnvelope,
} from "../src/config-history";
import { emptySecrets } from "../src/secret-bundle";
import {
  approveEnrollmentRequest,
  assertEnrollmentMembershipAccepted,
  assertSignedRevisionAccepted,
  canonicalJson,
  createConfigAcceptanceAcknowledgement,
  createEnrollmentRequest,
  createEnrollmentApproval,
  createEnrollmentCancellation,
  createGenesisEnrollment,
  createSignedConfigEnvelope,
  decodeEnrollmentApproval,
  decodeEnrollmentCancellation,
  decodeEnrollmentRequest,
  encodeEnrollmentCode,
  generateSigningKeyPair,
  sha256Canonical,
  verifyEnrollmentApproval,
  verifyEnrollmentCancellation,
  verifyEnrollmentChain,
  verifyConfigAcceptanceAcknowledgement,
  verifySignedConfigEnvelope,
  type LocalDeviceSigningRecord,
} from "../src/config-signing";

async function history(): Promise<ConfigHistoryEnvelope> {
  const { ageRecipient: _recipient, schemaVersion: _schema, ...settings } =
    structuredClone(DEFAULT_SETTINGS);
  const block = await createConfigHistoryBlock({
    schemaVersion: 1,
    settings,
    secrets: emptySecrets(),
  });
  return {
    format: "tephramesh-config-history-v1",
    retention: 10,
    blocks: [block],
  };
}

async function genesis() {
  const keys = await generateSigningKeyPair();
  const enrollment = await createGenesisEnrollment("instance-a", "device-a", keys);
  const local: LocalDeviceSigningRecord = {
    format: "tephramesh-local-device-signing-v1",
    bindingId: "mesh:instance-a",
    deviceId: "device-a",
    rootKeyId: keys.keyId,
    ...keys,
  };
  return { keys, enrollment, local };
}

describe("configuration signing", () => {
  it("canonicalizes object keys before signing", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: "value" } })).toBe(
      '{"a":{"b":"value","y":true},"z":1}',
    );
  });

  it("creates a self-signed genesis and verifies a signed configuration", async () => {
    const { enrollment, local } = await genesis();
    await expect(verifyEnrollmentChain([enrollment], local.keyId))
      .resolves.toBeUndefined();

    const envelope = await createSignedConfigEnvelope(
      await history(),
      [enrollment],
      local.keyId,
      1,
      local,
    );
    await expect(verifySignedConfigEnvelope(envelope)).resolves.toMatchObject({
      envelope: { revision: 1, signerKeyId: local.keyId },
    });

    const tampered = structuredClone(envelope);
    tampered.history.retention = 1;
    await expect(verifySignedConfigEnvelope(tampered)).rejects.toThrow(/signature/i);
  });

  it("signs and verifies acceptance of one exact configuration envelope", async () => {
    const { enrollment, local } = await genesis();
    const acknowledgement = await createConfigAcceptanceAcknowledgement(
      local.keyId,
      7,
      "a".repeat(64),
      local,
    );
    await expect(verifyConfigAcceptanceAcknowledgement(
      acknowledgement,
      local.keyId,
      7,
      "a".repeat(64),
      [enrollment],
      [],
    )).resolves.toMatchObject({ signerKeyId: local.keyId, revision: 7 });
    await expect(verifyConfigAcceptanceAcknowledgement(
      acknowledgement,
      local.keyId,
      8,
      "b".repeat(64),
      [enrollment],
      [],
    )).rejects.toThrow(/does not match/i);
    await expect(verifyConfigAcceptanceAcknowledgement(
      acknowledgement,
      local.keyId,
      7,
      "a".repeat(64),
      [enrollment],
      [local.keyId],
    )).rejects.toThrow(/signature/i);
    await expect(verifyConfigAcceptanceAcknowledgement(
      { ...acknowledgement, acceptedAt: new Date(0).toISOString() },
      local.keyId,
      7,
      "a".repeat(64),
      [enrollment],
      [],
    )).rejects.toThrow(/signature/i);
  });

  it("repairs an authenticated history affected by snapshot aliasing", async () => {
    const { enrollment, local } = await genesis();
    const aliasedHistory = await history();
    aliasedHistory.blocks[0]!.config.secrets.shardEncryptionKey =
      "authenticated mutation after hashing";
    const envelope = await createSignedConfigEnvelope(
      aliasedHistory,
      [enrollment],
      local.keyId,
      1,
      local,
    );

    const verified = await verifySignedConfigEnvelope(envelope);
    await expect(verifyConfigHistory(verified.envelope.history.blocks))
      .rejects.toThrow(/integrity/i);
    const repaired = await repairAliasedConfigHistory(
      verified.envelope.history.blocks,
    );
    await expect(verifyConfigHistory(repaired)).resolves.toBeUndefined();
  });

  it("requires an enrolled device to approve a new device key", async () => {
    const { enrollment: rootEnrollment, local: rootLocal } = await genesis();
    const joiningKeys = await generateSigningKeyPair();
    const request = createEnrollmentRequest("instance-b", "device-b", joiningKeys);
    expect(decodeEnrollmentRequest(encodeEnrollmentCode(request))).toEqual(request);

    const enrollment = await approveEnrollmentRequest(request, rootLocal);
    const enrollments = [rootEnrollment, enrollment];
    await expect(verifyEnrollmentChain(enrollments, rootLocal.keyId))
      .resolves.toBeUndefined();

    const currentEnvelope = await createSignedConfigEnvelope(
      await history(),
      [rootEnrollment],
      rootLocal.keyId,
      1,
      rootLocal,
    );
    const approval = await createEnrollmentApproval(
      rootLocal.keyId,
      1,
      await sha256Canonical(currentEnvelope),
      request,
      enrollments,
      rootLocal,
    );
    const decoded = decodeEnrollmentApproval(encodeEnrollmentCode(approval));
    const pending: LocalDeviceSigningRecord = {
      format: "tephramesh-local-device-signing-v1",
      bindingId: request.bindingId,
      deviceId: request.deviceId,
      pendingRequest: request,
      ...joiningKeys,
    };
    await expect(verifyEnrollmentApproval(decoded, pending)).resolves.toBeUndefined();

    decoded.request.nonce = "different";
    await expect(verifyEnrollmentApproval(decoded, pending)).rejects.toThrow(/match/i);
  });

  it("requires an enrolled signature to cancel the exact pending request", async () => {
    const { enrollment: rootEnrollment, local: rootLocal } = await genesis();
    const joiningKeys = await generateSigningKeyPair();
    const request = createEnrollmentRequest("instance-b", "device-b", joiningKeys);
    const pending: LocalDeviceSigningRecord = {
      format: "tephramesh-local-device-signing-v1",
      bindingId: request.bindingId,
      deviceId: request.deviceId,
      pendingRequest: request,
      ...joiningKeys,
    };
    const cancellation = await createEnrollmentCancellation(
      rootLocal.keyId,
      request,
      [rootEnrollment],
      rootLocal,
    );
    const decoded = decodeEnrollmentCancellation(encodeEnrollmentCode(cancellation));
    await expect(verifyEnrollmentCancellation(decoded, pending)).resolves.toBeUndefined();

    const differentRequest = createEnrollmentRequest("instance-b", "device-b", joiningKeys);
    await expect(verifyEnrollmentCancellation(decoded, {
      ...pending,
      pendingRequest: differentRequest,
    })).rejects.toThrow(/match/i);

    decoded.cancelledAt = new Date(0).toISOString();
    await expect(verifyEnrollmentCancellation(decoded, pending)).rejects.toThrow(/signature/i);
  });

  it("lets an approved Known-device installation sign the next configuration", async () => {
    const { enrollment: rootEnrollment, local: rootLocal } = await genesis();
    const currentEnvelope = await createSignedConfigEnvelope(
      await history(),
      [rootEnrollment],
      rootLocal.keyId,
      1,
      rootLocal,
    );
    const joiningKeys = await generateSigningKeyPair();
    const request = createEnrollmentRequest(
      "known:IPHONE-DEVICE-ID",
      "IPHONE-DEVICE-ID",
      joiningKeys,
    );
    const joiningEnrollment = await approveEnrollmentRequest(request, rootLocal);
    const enrollments = [rootEnrollment, joiningEnrollment];
    const approval = await createEnrollmentApproval(
      rootLocal.keyId,
      1,
      await sha256Canonical(currentEnvelope),
      request,
      enrollments,
      rootLocal,
    );
    const joiningLocal: LocalDeviceSigningRecord = {
      format: "tephramesh-local-device-signing-v1",
      bindingId: request.bindingId,
      deviceId: request.deviceId,
      rootKeyId: approval.rootKeyId,
      pendingRequest: request,
      ...joiningKeys,
    };
    await expect(verifyEnrollmentApproval(approval, joiningLocal))
      .resolves.toBeUndefined();

    const nextEnvelope = await createSignedConfigEnvelope(
      await history(),
      approval.enrollments,
      approval.rootKeyId,
      2,
      joiningLocal,
    );
    await expect(verifySignedConfigEnvelope(nextEnvelope)).resolves.toMatchObject({
      envelope: {
        revision: 2,
        signerKeyId: joiningLocal.keyId,
      },
    });
  });

  it("rejects tampered approval anchor metadata", async () => {
    const { enrollment: rootEnrollment, local: rootLocal } = await genesis();
    const joiningKeys = await generateSigningKeyPair();
    const request = createEnrollmentRequest("instance-b", "device-b", joiningKeys);
    const enrollment = await approveEnrollmentRequest(request, rootLocal);
    const approval = await createEnrollmentApproval(
      rootLocal.keyId,
      3,
      "authenticated-envelope-hash",
      request,
      [rootEnrollment, enrollment],
      rootLocal,
    );
    approval.approvedRevision = 4;
    const pending: LocalDeviceSigningRecord = {
      format: "tephramesh-local-device-signing-v1",
      bindingId: request.bindingId,
      deviceId: request.deviceId,
      pendingRequest: request,
      ...joiningKeys,
    };
    await expect(verifyEnrollmentApproval(approval, pending))
      .rejects.toThrow(/signature/i);
  });

  it("rejects an approval whose enrollment belongs to a different request", async () => {
    const { enrollment: rootEnrollment, local: rootLocal } = await genesis();
    const requestedKeys = await generateSigningKeyPair();
    const otherKeys = await generateSigningKeyPair();
    const request = createEnrollmentRequest("known:iphone", "iphone", requestedKeys);
    const otherRequest = createEnrollmentRequest("known:ipad", "ipad", otherKeys);
    const otherEnrollment = await approveEnrollmentRequest(otherRequest, rootLocal);
    await expect(createEnrollmentApproval(
      rootLocal.keyId,
      1,
      "authenticated-envelope-hash",
      request,
      [rootEnrollment, otherEnrollment],
      rootLocal,
    )).rejects.toThrow(/requested device enrollment/i);
  });

  it("rejects a local signing record with a mismatched private key", async () => {
    const { enrollment, local } = await genesis();
    const unrelated = await generateSigningKeyPair();
    await expect(createSignedConfigEnvelope(
      await history(),
      [enrollment],
      local.keyId,
      1,
      { ...local, privateKey: unrelated.privateKey },
    )).rejects.toThrow(/does not match/i);
  });

  it("rejects rollback and same-revision conflicts against local state", async () => {
    const { local } = await genesis();
    const anchored = {
      ...local,
      lastAcceptedRevision: 8,
      lastAcceptedEnvelopeHash: "revision-eight",
    };
    expect(() => assertSignedRevisionAccepted(anchored, 8, "revision-eight"))
      .not.toThrow();
    expect(() => assertSignedRevisionAccepted(anchored, 9, "revision-nine"))
      .not.toThrow();
    expect(() => assertSignedRevisionAccepted(anchored, 7, "revision-seven"))
      .toThrow(/rolled-back/i);
    expect(() => assertSignedRevisionAccepted(anchored, 8, "other-branch"))
      .toThrow(/conflicting/i);
  });

  it("requires membership continuity and preserves revocations", async () => {
    const { enrollment, local } = await genesis();
    const otherKeys = await generateSigningKeyPair();
    const other = await approveEnrollmentRequest(
      createEnrollmentRequest("instance-b", "device-b", otherKeys), local,
    );
    const anchored = {
      ...local,
      lastAcceptedEnrollmentKeyIds: [enrollment.keyId, other.keyId],
      lastAcceptedRevokedEnrollmentKeyIds: [],
    };
    expect(() => assertEnrollmentMembershipAccepted(anchored, [enrollment]))
      .toThrow(/omitted/i);
    expect(() => assertEnrollmentMembershipAccepted(
      anchored, [enrollment], [other.keyId],
    )).not.toThrow();
    expect(() => assertEnrollmentMembershipAccepted(
      { ...anchored, lastAcceptedEnrollmentKeyIds: [enrollment.keyId], lastAcceptedRevokedEnrollmentKeyIds: [other.keyId] },
      [enrollment], [],
    )).toThrow(/revoked/i);
  });

  it("rejects a revoked signer when creating an envelope", async () => {
    const { enrollment, local } = await genesis();
    await expect(createSignedConfigEnvelope(
      await history(), [enrollment], local.keyId, 1, local, [local.keyId],
    )).rejects.toThrow(/membership/i);
  });
});
