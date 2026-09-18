# Device signing

Tephramesh device signing authorizes installations to read, change, and accept
the encrypted Tephramesh configuration. It is separate from Syncthing peer
trust and from optional vault-note content signing.

## What is signed

The signed configuration envelope contains:

- the encrypted configuration history;
- a monotonic configuration revision;
- the enrollment root identifier;
- the public key and certificate-like enrollment record for every enrolled
  installation;
- the list of revoked enrollment keys; and
- the key identifier of the installation that authored the revision.

The envelope is signed with an enrolled installation's P-256 ECDSA key. The
signature covers the canonical JSON representation of the complete envelope.
Tephramesh also hashes that envelope. The revision and hash together identify
the exact configuration that an installation accepted.

## Keys and storage

Each installation has one device-signing key pair. The private key is stored
locally in Obsidian Keychain under `tephramesh-device-signing`; it is never
written to `data.json` or synchronized through the vault. Public keys,
enrollment records, and signatures are stored inside the age-encrypted
configuration.

An enrollment record binds a public signing key to both a Tephramesh binding
and a Syncthing device ID. A binding can represent an active device or a Known
device. Shards cannot enroll signing keys.

## Example artifacts

The following examples show the kinds of files and data Tephramesh may create.
The identifiers, keys, hashes, timestamps, and signatures are shortened or
replaced with placeholders. They are not valid credentials.

### Local Keychain record

The private signing key stays in the local Obsidian Keychain entry
`tephramesh-device-signing`. Its value is conceptually similar to:

```json
{
   "format": "tephramesh-local-device-signing-v1",
   "bindingId": "mesh:device-a",
   "deviceId": "DEVICE-A-SYNCTHING-ID",
   "rootKeyId": "a1b2c3...",
   "keyId": "a1b2c3...",
   "publicKey": "MIIBIjANBgkqhkiG9w0BAQE...",
   "privateKey": "MIGHAgEAMBMGByqGSM49AgEG...",
   "lastAcceptedRevision": 12,
   "lastAcceptedEnvelopeHash": "9f8e7d..."
}
```

This is a conceptual example only. The private key is not placed in
`.obsidian/plugins/tephramesh/data.json`, the configuration journal, or any
copy/paste enrollment code.

### Enrollment request

When a new installation requests approval, the code encodes data shaped like
this request:

```json
{
   "format": "tephramesh-device-enrollment-request-v1",
   "bindingId": "mesh:device-b",
   "deviceId": "DEVICE-B-SYNCTHING-ID",
   "keyId": "b4c5d6...",
   "publicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQc...",
   "nonce": "random-request-nonce",
   "createdAt": "2026-09-17T12:00:00.000Z"
}
```

The request is transferred manually. It is not saved as a synchronized
configuration file. The approver returns another encoded object containing the
request, the complete enrollment chain, the current revision and envelope
hash, the approver key ID, and an approval signature.

### Synchronized configuration envelope

The plaintext `data.json` envelope contains only the outer schema, public age
recipient, and ciphertext:

```json
{
   "schemaVersion": 3,
   "ageRecipient": "age1pq1...",
   "encryptedData": "-----BEGIN AGE ENCRYPTED FILE-----..."
}
```

After decryption, the ciphertext may contain a signed envelope shaped like
this:

```json
{
   "format": "tephramesh-signed-config-v1",
   "rootKeyId": "a1b2c3...",
   "revision": 12,
   "enrollments": [
      {
         "format": "tephramesh-device-enrollment-v1",
         "bindingId": "mesh:device-a",
         "deviceId": "DEVICE-A-SYNCTHING-ID",
         "keyId": "a1b2c3...",
         "publicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQc...",
         "requestNonce": "genesis",
         "approvedByKeyId": "a1b2c3...",
         "createdAt": "2026-09-16T10:00:00.000Z",
         "signature": "MEUCIQ..."
      }
   ],
   "revokedEnrollmentKeyIds": [],
   "history": {
      "format": "tephramesh-config-history-v1",
      "retention": 10,
      "blocks": ["encrypted-history-blocks"]
   },
   "signerKeyId": "a1b2c3...",
   "signature": "MEUCIQ..."
}
```

The actual history blocks contain the protected settings and secrets inside
the age-encrypted payload. The public envelope does not make those secrets
plaintext.

### Acknowledgement and confirmation files

After an installation accepts revision 12, it may write a signed file such as
`.obsidian/plugins/tephramesh/config-acks/12-<envelope-hash>/b4c5d6....json`:

```json
{
   "format": "tephramesh-config-acceptance-v1",
   "rootKeyId": "a1b2c3...",
   "revision": 12,
   "envelopeHash": "9f8e7d...",
   "signerKeyId": "b4c5d6...",
   "acceptedAt": "2026-09-17T12:05:00.000Z",
   "signature": "MEQCIA..."
}
```

The same installation can write a signed observation under the `confirmations`
subdirectory:

```json
{
   "format": "tephramesh-config-acceptance-confirmation-v1",
   "rootKeyId": "a1b2c3...",
   "revision": 12,
   "envelopeHash": "9f8e7d...",
   "signerKeyId": "b4c5d6...",
   "observedSignerKeyIds": ["a1b2c3...", "b4c5d6..."],
   "observedAt": "2026-09-17T12:06:00.000Z",
   "signature": "MEQCIA..."
}
```

These acknowledgement and confirmation files contain no operational settings
or secrets. Tephramesh verifies their root, revision, envelope hash, signer,
enrollment membership, and signature before counting them.

## Initial enrollment

Signing is initialized automatically when fresh setup adds the first device.
That installation becomes the enrollment root and the first approver. The root
record is self-signed. An existing unsigned encrypted configuration can also be
initialized explicitly on exactly one installation without changing its
operational contents.

The enrollment root is an anchor, not a password. Every later enrollment must
be traceable through signed records back to that root. Tephramesh verifies the
complete chain before accepting a signed configuration.

## Adding another installation

Enrollment is deliberately manual and copy/paste-only:

1. The new installation generates a P-256 key pair locally and creates an
   enrollment request containing its binding, device ID, public key, and a
   random nonce.
2. An already enrolled installation reviews the request against synchronized
   device metadata. The review identifies the requested device and its signing
   key before approval.
3. A second approval action signs the request and returns an approval code.
   The approval is tied to the current signed configuration revision and hash.
4. The requesting installation verifies the approval, the enrollment chain, and
   the matching revision/hash before saving the new local enrollment state.
5. The next signed configuration revision carries the new enrollment record.

The request and approval do not poll localhost, add plaintext configuration
fields, or synchronize unsigned enrollment state. If the configuration changes
between request approval and completion, the approval is stale and must be
recreated. An enrolled approver can also issue a signed cancellation for a
reviewed request; the requester accepts it only when it matches its local
pending request.

While approval is pending, the installation may unlock and read the signed
configuration for enrollment, but normal mesh polling and configuration changes
remain suspended.

## Saving configuration

Every enrolled installation may author a new signed revision. A save:

1. derives the protected configuration history;
2. verifies the current enrollment chain and revocation list;
3. signs the complete envelope with the local enrolled key;
4. records the encrypted signed envelope in the local configuration journal;
5. writes the authoritative encrypted `data.json`; and
6. records the local installation's accepted revision and envelope hash.

Saves are serialized so concurrent callers cannot allocate the same revision
from stale local state. A signed save also writes a best-effort partial scan
request for the Tephramesh configuration subpath so synchronized installations
notice the update promptly.

## Acceptance and propagation

Enrollment answers “who may sign.” Acceptance answers “who has loaded this
exact revision.” After verifying and loading a signed envelope, an installation
writes a signed acknowledgement under `config-acks/<revision>-<hash>`. The
acknowledgement is accepted only when its root, revision, hash, signer, and
signature match the current active enrollment chain.

An installation also writes a signed confirmation listing the enrolled keys it
has observed accepting that revision. The Signing tab therefore reports two
different facts:

- **Using this configuration:** enrolled installations that acknowledged the
  exact current revision;
- **Know this device is up to date:** enrolled installations that have reported
  seeing this installation's acknowledgement.

The local installation counts its own verified acceptance immediately. Peer
counts require verified confirmation files. Malformed, stale, forged, and
revoked acknowledgements or confirmations are ignored and retried on later
refreshes.

## Revocation and continuity

The enrollment root can revoke another enrolled key by saving a new signed
revision. Revoked keys remain in history for verification but cannot sign new
configuration envelopes, acknowledgements, or confirmations, and cannot be
re-enrolled. The root key itself cannot be revoked by the local installation.

Each installation anchors the previously accepted active and revoked key sets
locally. Later envelopes must preserve that membership or explicitly revoke a
key; a revoked key cannot silently return.

## Conflicts and recovery

If two installations create different signed envelopes at the same revision,
Tephramesh rejects the conflicting branch rather than silently choosing one.
The installation keeps its age identity but pauses ordinary configuration
saves and shows a persistent conflict state. The user can explicitly keep the
currently synchronized branch; Tephramesh then signs its contents as the next
revision. Selecting and merging an alternate journal branch is not automatic.

If every enrolled private signing key is lost, an installation that still has
the Keychain binding for an enrolled device can expose the recovery **Delete
Config** action. Deletion removes the synced Tephramesh configuration, journal,
acknowledgements, and confirmations, but does not change Syncthing settings,
vault files, or the private age identity. A fresh unsigned installation without
that binding cannot delete a signed configuration.

## Trust boundaries

Device signing does not encrypt vault content, replace age encryption, or
change Syncthing's trust settings. It protects authorization and configuration
continuity. The age private identity remains the credential needed to decrypt
the configuration, while the device-signing private key is the credential
needed to participate in its signed authorization chain.