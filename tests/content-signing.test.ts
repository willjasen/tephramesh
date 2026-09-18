import { describe, expect, it } from "vitest";
import {
  createGenesisEnrollment,
  generateSigningKeyPair,
  type LocalDeviceSigningRecord,
} from "../src/config-signing";
import {
  contentSignaturePath,
  createContentSignature,
  hasLocalContentChange,
  isContentSignaturePath,
  verifyContentSignature,
} from "../src/content-signing";

async function signingFixture() {
  const keys = await generateSigningKeyPair();
  const enrollment = await createGenesisEnrollment("mesh:device", "DEVICE-ID", keys);
  const local: LocalDeviceSigningRecord = {
    format: "tephramesh-local-device-signing-v1",
    bindingId: "mesh:device",
    deviceId: "DEVICE-ID",
    rootKeyId: keys.keyId,
    ...keys,
  };
  return { local, enrollment };
}

describe("vault content signing", () => {
  it("creates and verifies a path-bound signature", async () => {
    const { local, enrollment } = await signingFixture();
    const content = new TextEncoder().encode("# Signed note\n").buffer;
    const record = await createContentSignature("Notes/signed.md", content, local.keyId, local);
    await expect(verifyContentSignature(
      record, "Notes/signed.md", content, local.keyId, [enrollment],
    )).resolves.toEqual(record);
  });

  it("rejects changed content and paths", async () => {
    const { local, enrollment } = await signingFixture();
    const original = new TextEncoder().encode("original").buffer;
    const record = await createContentSignature("note.md", original, local.keyId, local);
    await expect(verifyContentSignature(
      record, "note.md", new TextEncoder().encode("changed").buffer,
      local.keyId, [enrollment],
    )).rejects.toThrow(/changed/i);
    await expect(verifyContentSignature(
      record, "other.md", original, local.keyId, [enrollment],
    )).rejects.toThrow(/metadata/i);
  });

  it("uses hidden, deterministic records and excludes internal paths", async () => {
    expect(await contentSignaturePath("note.md")).toMatch(/^\.tephramesh\/signatures\/[a-f0-9]{64}\.json$/);
    expect(isContentSignaturePath(".tephramesh/signatures/a.json")).toBe(true);
    const { local } = await signingFixture();
    await expect(createContentSignature(
      ".obsidian/plugins/example/data.json", new ArrayBuffer(0), local.keyId, local,
    )).rejects.toThrow(/cannot be signed/i);
  });

  it("distinguishes user edits from programmatic document replacement", () => {
    const transaction = (docChanged: boolean, userEvent?: string) => ({
      docChanged,
      isUserEvent: (event: string) => userEvent === event || userEvent?.startsWith(`${event}.`) === true,
    });
    expect(hasLocalContentChange([transaction(true, "input.type")])).toBe(true);
    expect(hasLocalContentChange([transaction(true, "delete.backward")])).toBe(true);
    expect(hasLocalContentChange([transaction(true, "undo")])).toBe(true);
    expect(hasLocalContentChange([transaction(true)])).toBe(false);
    expect(hasLocalContentChange([transaction(false, "select.pointer")])).toBe(false);
  });
});
