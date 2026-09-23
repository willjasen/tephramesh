import { describe, expect, it } from "vitest";
import {
  createRootRotationTransition,
  createSignedConfigEnvelope,
  createGenesisEnrollment,
  generateSigningKeyPair,
  reissueEnrollmentsForRotatedRoot,
  verifySignedConfigEnvelope,
  type LocalDeviceSigningRecord,
} from "../src/config-signing";
import { createConfigHistoryBlock, type ConfigHistoryEnvelope } from "../src/config-history";
import { DEFAULT_SETTINGS } from "../src/model";
import { emptySecrets } from "../src/secret-bundle";

async function history(): Promise<ConfigHistoryEnvelope> {
  const { ageRecipient: _recipient, schemaVersion: _schema, ...settings } =
    structuredClone(DEFAULT_SETTINGS);
  const block = await createConfigHistoryBlock({
    schemaVersion: 1,
    settings,
    secrets: emptySecrets(),
  });
  return { format: "tephramesh-config-history-v1", retention: 10, blocks: [block] };
}

describe("root rotation compatibility", () => {
  it("accepts a legacy transition without previous enrollments", async () => {
    const oldKeys = await generateSigningKeyPair();
    const oldEnrollment = await createGenesisEnrollment("mesh:root", "device-root", oldKeys);
    const oldLocal: LocalDeviceSigningRecord = {
      format: "tephramesh-local-device-signing-v1",
      bindingId: "mesh:root",
      deviceId: "device-root",
      rootKeyId: oldKeys.keyId,
      ...oldKeys,
    };
    const newKeys = await generateSigningKeyPair();
    const completeTransition = await createRootRotationTransition(
      oldKeys.keyId,
      newKeys,
      oldLocal,
      oldLocal.bindingId,
      oldLocal.deviceId,
      [oldEnrollment],
    );
    const legacyTransition = structuredClone(completeTransition);
    delete legacyTransition.previousEnrollments;
    const newEnrollments = await reissueEnrollmentsForRotatedRoot(
      [oldEnrollment],
      newKeys,
      oldLocal.bindingId,
      oldLocal.deviceId,
    );
    const newLocal: LocalDeviceSigningRecord = {
      ...oldLocal,
      ...newKeys,
      rootKeyId: newKeys.keyId,
      rootPublicKey: newKeys.publicKey,
      rootPrivateKey: newKeys.privateKey,
    };
    const envelope = await createSignedConfigEnvelope(
      await history(),
      newEnrollments,
      newKeys.keyId,
      1,
      newLocal,
      [],
      legacyTransition,
    );
    await expect(verifySignedConfigEnvelope(envelope)).resolves.toBeTruthy();
  });
});
