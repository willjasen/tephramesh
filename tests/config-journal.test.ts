import { describe, expect, it } from "vitest";
import { createConfigJournalRecord, isConfigJournalRecord } from "../src/config-journal";

describe("config journal", () => {
  it("creates unique valid records", () => {
    const hash = "a".repeat(64);
    const first = createConfigJournalRecord(4, hash, "signer-a", "ciphertext");
    const second = createConfigJournalRecord(4, hash, "signer-a", "ciphertext");
    expect(isConfigJournalRecord(first)).toBe(true);
    expect(isConfigJournalRecord(second)).toBe(true);
    expect(first.changeId).not.toBe(second.changeId);
  });

  it("rejects malformed or oversized index metadata", () => {
    const valid = createConfigJournalRecord(1, "b".repeat(64), "signer-b", "ciphertext");
    expect(isConfigJournalRecord({ ...valid, revision: 0 })).toBe(false);
    expect(isConfigJournalRecord({ ...valid, envelopeHash: "not-a-hash" })).toBe(false);
    expect(isConfigJournalRecord({ ...valid, changeId: "../data" })).toBe(false);
    expect(isConfigJournalRecord({ ...valid, createdAt: "not-a-date" })).toBe(false);
  });
});
