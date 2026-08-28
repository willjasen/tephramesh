# Tephramesh architecture

## Trust boundaries

Tephramesh manages one Syncthing folder ID per Obsidian vault.

| Local instance | Remote instance | Peer trust | Folder password on share | Local folder type |
| --- | --- | --- | --- | --- |
| Device | Device | Trusted (managed) | Empty | Send & Receive |
| Device | Shard | Unchanged (unmanaged) | Shard encryption key | Send & Receive |
| Shard | Device | Unchanged (unmanaged) | Empty | Receive Encrypted |
| Shard | Shard | Unchanged (unmanaged) | Empty | Receive Encrypted |

The shard encryption key belongs only on devices. A shard stores and exchanges the encrypted representation without learning the key. Because a shard may also host ordinary folders, Tephramesh never sets or audits Syncthing peer trust for a relationship involving a shard; it attaches the shard encryption key only to device-to-shard folder shares.

API keys are administrative credentials. Tephramesh stores its entire operational state and secrets in one versioned age-encrypted payload. New configurations generate a dedicated hybrid ML-KEM-768 + X25519 age identity locally; classic and post-quantum native age identities can also be imported. The plaintext envelope contains only `schemaVersion`, the public recipient, and Base64 ciphertext. Each Obsidian installation stores the matching private identity locally in Keychain under `tephramesh-age-identity`. A copied `data.json` reveals neither topology nor API access without that identity.

Age setup also generates the mesh's `sk-` shard encryption key automatically. The key and its SHA-256 fingerprint are included in the protected payload before the first save; a legacy key is preserved during migration.

## Why the folder ID is global and paths are local

Syncthing identifies a shared folder by ID. Every member of the mesh must use the same ID, while labels and filesystem paths may vary. Tephramesh therefore stores:

- one vault-wide folder ID and default label;
- one absolute folder path for each instance;
- one Syncthing device ID and management endpoint for each instance.

An endpoint contains protocol, hostname, port, and an optional normalized reverse-proxy path. The setup UI treats the complete URL as the primary input and keeps its component fields synchronized. The path prefixes every Syncthing REST endpoint and the displayed web UI link.

Syncthing is authoritative for instance names. Tephramesh discovers the local device entry by matching `/rest/system/status`'s device ID against `/rest/config/devices`, then periodically refreshes the saved display name. Device IDs, rather than mutable names, remain the stable identity keys.

Tephramesh is authoritative for the managed folder label. A label edit is debounced, applied to all reachable instances through the granular folder configuration endpoint, and verified by reading the folder back. Periodic refresh reconciles an instance that was unavailable during the original edit.

The plugin never syncs Syncthing's own configuration directory. Doing so could duplicate device identity keys and corrupt the mesh.

## Reconciliation design

Peer and folder-sharing configuration writes use an idempotent reconciler rather than a sequence of invitation dialogs. Initial folder creation is automated from each Syncthing instance's default-folder template. The Topology tab audits the mesh at startup, approximately every five minutes, and on demand; it previews repairable and blocking issues before enabling repair.

1. Read status, version, devices, folders, pending devices, and pending folders from every reachable instance.
2. Verify that endpoint identity still matches the recorded Syncthing device ID.
3. Refuse ambiguous states: duplicate device IDs, a folder ID pointing to an unexpected path, plaintext data in a proposed shard path, or a shard folder whose type is not Receive Encrypted.
4. Produce a field-level preview while preserving unrelated devices, folders, and unknown configuration fields.
5. Ensure peer device records exist on all instances.
6. Create or update the Receive Encrypted folder on shards before devices advertise it.
7. Update managed-folder shares, attaching the password only to shard peers while preserving shard-related peer-trust settings.
8. Configure shard-to-shard ciphertext sharing.
9. Remove unregistered peers from the managed Tephramesh folder while preserving unrelated global Syncthing device and folder configuration.
10. Re-read each configuration and runtime folder status. Stop on the first failed instance and leave a rerunnable, convergent plan.

There is no cross-instance Syncthing transaction. Tephramesh must therefore avoid rollback-by-deletion; a retry should safely converge partially applied configuration toward the same desired state.

Repair remains disabled while an instance is unreachable, an endpoint reports a different identity, a configured path is owned by another folder, a managed folder has the wrong path or type, or an existing folder is not idle and complete. Syncthing's REST API cannot safely classify arbitrary pre-existing files in an otherwise unconfigured shard path, so first-time shard path safety still relies on the add-instance validation and the operator choosing an empty encrypted-storage location.

## Topology growth

A complete mesh of `n` instances has `n(n-1)/2` peer relationships. Adding instance `n+1` creates `n` new relationships, but requires configuration checks on all `n+1` instances. The planner computes desired state from the complete registry each time instead of trying to maintain incremental edge history.

This provides direct device-to-device synchronization when available while allowing an online shard to bridge changes between devices that are never online together.

## Controller evolution

The first beta uses the current Obsidian device as a controller. Its one local age identity unlocks the synced API-key bundle for every endpoint it monitors. The intended distributed model is:

- each Obsidian device applies its own configuration through localhost;
- one elected controller manages headless shards;
- desired state and age ciphertext sync with the vault;
- the private age identity and controller authority never sync through the vault.

This reduces the number of remote administrative APIs that must be exposed and avoids copying every instance's API key to every device.
