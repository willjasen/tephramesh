# Vault file signing

Vault file signing proves which enrolled Tephramesh installation signed a
specific version of a file. It is separate from plugin-configuration signing:

- **Configuration signing** authorizes an installation to change the encrypted
  Tephramesh configuration.
- **Vault file signing** records authorship for vault content. It does not
  authorize configuration changes and it does not encrypt the file.

The signed file remains ordinary vault content. The signature is stored beside
it in Tephramesh's hidden signature directory so the file can still be opened,
edited, and synchronized normally.

## Current scope

The current user-facing workflow signs Markdown notes:

1. An enrolled installation runs **Enable signing for current note**.
2. Tephramesh hashes the note's bytes and signs a record with that note's vault
   path, content hash, byte length, signer key ID, and timestamp.
3. The record is written below `.tephramesh/signatures`.
4. Other installations receive the note and its signature record through the
   normal vault sync flow.
5. Each installation verifies the record locally and shows **Note last signed
   by [device name]** when the content and signature are valid.

The command is available only when the local installation is enrolled for
configuration signing. Enrollment supplies the trusted public-key chain; it
does not make the vault content secret.

## What is signed

The signature covers a canonical record shaped like this:

```json
{
  "format": "tephramesh-content-signature-v1",
  "rootKeyId": "<enrollment-root-key-id>",
  "path": "Notes/example.md",
  "contentHash": "<sha-256-of-file-bytes>",
  "byteLength": 1234,
  "signerKeyId": "<enrolled-signing-key-id>",
  "signedAt": "2026-09-18T12:00:00.000Z",
  "signature": "<p-256-signature>"
}
```

The signature covers every field except `signature` itself. The path and hash
are both authenticated, so a valid record cannot be moved to another file or
reused for different content. The byte length is checked as well as the hash.

The record filename is deterministic. It is derived from the vault path and
content hash and is stored under:

```text
.tephramesh/signatures/<content-address>.json
```

Because the content hash is part of the filename, different signed versions do
not overwrite one another. This also leaves an immutable local history of
signed versions, subject to normal vault synchronization and file cleanup.

## Signing an edit

A signature describes one exact file version. Editing a signed note therefore
makes the old signature invalid; it does not make the old signature describe
the new text.

For a direct editor action, Tephramesh records local authorship intent for
input, deletion, move, undo, or redo. After Obsidian writes the changed note,
Tephramesh finds the existing signature by vault path and creates a new
signature record for the new content. This path lookup matters because the new
content hash has no record until the replacement signature is written.

The status bar shows **Signing local note edit...** while the replacement is
pending and **Updating note signature...** while the note and signature files
settle. Once verification succeeds, it shows the installation that signed the
current content.

A programmatic replacement, such as a note arriving from Syncthing, does not
create local authorship intent. It is verified against the synchronized
signature instead of being silently re-signed by the receiving installation.

## Verification

An installation accepts a vault signature only when all of these checks pass:

1. The record has the expected format and valid metadata.
2. The record path is the path of the file being checked.
3. The signer belongs to the current enrollment chain.
4. The signer key has not been revoked.
5. The P-256 signature matches the canonical record.
6. The file's current bytes produce the recorded SHA-256 hash and byte length.

If any check fails, the file is still available, but the status bar reports
that its signature is missing or invalid. A failed verification does not modify
the note.

## Rename, delete, and disable

When a signed note is renamed, Tephramesh follows the signature to the new
path and signs the renamed content under the new path. Deleted notes have their
signature records removed. **Disable signing for current note** removes the
records associated with that note without changing the note itself.

The `.obsidian` directory and Tephramesh's own `.tephramesh` data are never
eligible for vault-content signing.

## Trust and limitations

Vault file signing proves that an enrolled key signed the exact bytes at the
recorded path. It does not prove that:

- the signer is the only person who edited the file;
- the file was delivered to every installation;
- the vault contains no unsigned files;
- the file is encrypted or protected from a user who can edit the vault; or
- the signer approved the meaning of the file.

The private signing key remains in the local Obsidian Keychain. Public
 enrollment records and signature records may synchronize through the vault,
but private keys, API keys, age identities, and encrypted configuration
secrets do not belong in a vault signature record.

The current command targets Markdown notes. The record format hashes arbitrary
file bytes, so the same verification model can support attachments and other
vault files later, provided the UI and local-authorship rules are extended for
those file types.
