# Vault file signing and encryption

Vault file signing proves which enrolled Tephramesh installation signed a
specific version of a file. It is separate from plugin-configuration signing:

- **Configuration signing** authorizes an installation to change the encrypted
  Tephramesh configuration.
- **Vault file signing** records authorship for vault content. It does not
  authorize configuration changes and it does not encrypt the file.
- **Vault file encryption** stores the file as an age-encrypted `.age` sibling.
  Encryption automatically signs the ciphertext before the plaintext is
  removed from the vault.

The signature is stored beside the file in Tephramesh's hidden signature
directory. Plain signed files remain ordinary vault content. Encrypted files
are synchronized as ciphertext and must be decrypted before they can be opened
or edited in Obsidian.

## File-menu actions

Right-click a vault file to access the signing and encryption actions. Signing
is available for any file that is not inside `.obsidian` or Tephramesh's own
`.tephramesh` directory. Encryption is available when the local installation
is unlocked and enrolled:

1. **Encrypt vault file** creates `File.ext.age`, signs its ciphertext, and
  removes the plaintext `File.ext`.
2. Syncthing distributes the `.age` file and its signature record normally.
3. Opening the `.age` file uses Tephramesh's encrypted-file editor. It verifies
  the ciphertext and decrypts it only in memory, so the file remains editable
  without writing plaintext to disk.
4. Saving the editor re-encrypts the updated text, signs the new ciphertext,
  and writes only the encrypted bytes back to the `.age` file.
5. **Decrypt vault file** remains available when a plaintext copy is needed;
  it verifies the ciphertext, restores `File.ext`, and removes the `.age`
  file and its signature.

Encryption therefore implies signing. A ciphertext with no valid signature is
not decrypted by the file-menu action. The encrypted-file editor handles
`.age` files as a custom Obsidian view rather than exposing ciphertext to the
normal Markdown editor. **Decrypt current vault file** remains available from
the command palette when a plaintext copy is explicitly wanted.

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
not overwrite one another. Tephramesh retains the five newest valid signature
records per vault path. Older records are removed after a new local signature
is written; malformed records are left in place for inspection rather than
being deleted automatically.

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

The editor automatically re-signs direct edits to Markdown notes. Other file
types can be signed from the file menu, but changing them does not currently
trigger automatic re-signing; they must be signed again from the file menu.
