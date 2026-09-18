# Configuration encryption

Tephramesh uses [age](https://age-encryption.org/) to protect its plugin
configuration. Encryption protects the configuration data that must travel
with the vault, especially Syncthing API keys and the shard encryption key.
It is separate from device signing and separate from Syncthing's encryption of
network traffic.

## What age protects

The age-encrypted payload contains the operational Tephramesh configuration:

- mesh instances, endpoints, folder metadata, and polling settings;
- API keys keyed by instance ID;
- the shard encryption key; and
- configuration history and signing metadata.

The plaintext plugin file contains only the outer envelope:

```json
{
  "schemaVersion": 3,
  "ageRecipient": "age1pq1...",
  "encryptedData": "<base64 age ciphertext>"
}
```

The settings and secrets inside `encryptedData` are not readable by Syncthing
peers that can access the vault files but do not have the matching private age
identity.

## Identity and recipient

During fresh setup, Tephramesh generates a dedicated native age identity using
the hybrid post-quantum age mode based on ML-KEM-768 and X25519. The generated
private identity begins with `AGE-SECRET-KEY-PQ-1`; its public recipient begins
with `age1pq1`.

The private identity is stored only in the local Obsidian Keychain under
`tephramesh-age-identity`. The public recipient is stored in the plaintext
envelope so every installation can determine which identity is required. The
private identity is never written to `data.json` or synchronized through
Syncthing.

Before storing an identity, Tephramesh derives its recipient and compares it
with the configured public recipient. A mismatched identity cannot unlock the
configuration. A newly synced Obsidian installation therefore remains locked
until the user enters the matching identity once; after that, it can use its
local Keychain copy for future reloads.

The identity is a decryption credential, not a device-signing key. It does not
authorize configuration changes by itself.

## Encryption flow

When Tephramesh saves configuration, it:

1. builds the versioned protected payload containing `settings` and `secrets`;
2. serializes the current configuration history;
3. optionally wraps that history in a signed configuration envelope;
4. encrypts the resulting JSON with the age public recipient;
5. encodes the ciphertext for storage in `encryptedData`; and
6. writes the small plaintext envelope to `.obsidian/plugins/tephramesh/data.json`.

The age library performs authenticated encryption. Decryption therefore both
recovers the plaintext and detects a wrong identity or modified ciphertext.
Tephramesh then validates the decrypted schema and, when present, verifies the
configuration history and signing envelope.

Conceptually, the decrypted payload looks like this:

```json
{
  "schemaVersion": 1,
  "settings": {
    "folderId": "tephramesh-ab12cd34",
    "instances": "<configured mesh instances>",
    "configHistoryVersions": 10
  },
  "secrets": {
    "apiKeys": {
      "device-a": "<Syncthing API key>"
    },
    "shardEncryptionKey": "sk-<random value>"
  }
}
```

This is an illustrative shape, not a complete export format. The decrypted
payload is held in memory only while Tephramesh is unlocked, and secret-bearing
helpers are kept behind the plugin's internal access boundary.

## Configuration history

Tephramesh keeps a bounded history of complete protected snapshots. Each history
block contains a configuration hash, timestamp, version, and a link to the
previous block's hash. The default retention is ten versions and the supported
range is one through ten.

The history chain provides integrity and restore points; age provides
confidentiality and authenticated decryption. Device signing provides
authorization and cross-installation continuity. These are three different
protections:

| Protection | Answers |
| --- | --- |
| age encryption | Who can decrypt the configuration? |
| history hashes | Has the snapshot chain been altered or broken? |
| device signatures | Which enrolled installation authorized this revision? |

Signed configurations contain the history inside the signed envelope before
the envelope is encrypted. A configuration change therefore needs both a valid
age decryption and a valid signing chain when signing has been initialized.

## What age does not encrypt

Age encryption protects Tephramesh's plugin configuration, not every file in
the vault. Device vault data remains plaintext at rest on device instances and
is protected in transit by Syncthing. A shard stores the managed folder as
Syncthing `receiveencrypted` data; that is a separate Syncthing folder mode
using the shard encryption key.

The shard encryption key is generated during age setup and stored inside the
age-encrypted secret bundle. It is supplied when Tephramesh configures device
to shard folder sharing. It is not displayed as normal settings data and is
not stored as a plaintext hash that can replace the protected key.

## Operational consequences

- Back up the private age identity securely. Without it, a new installation
  cannot decrypt the synchronized configuration.
- Do not put the private identity, API keys, or shard encryption key in issue
  reports, screenshots, enrollment codes, or source control.
- Copying `data.json` is safe only in the sense that its protected payload is
  encrypted; access to the file alone does not provide the private identity.
- Deleting Tephramesh configuration does not delete the local age identity from
  Obsidian Keychain. A later setup may still use that identity if its recipient
  is appropriate.
- An age identity cannot authorize a configuration save on an installation
  that is not enrolled for device signing.
