# Tephramesh

Tephramesh is an Obsidian plugin for monitoring and, eventually, safely configuring a dedicated Syncthing mesh for a single Obsidian vault.

> [!IMPORTANT]
> This is an early, safety-focused beta. It creates the managed folder, connects to and monitors Syncthing, records devices and encrypted shards, and configures each newly added instance with its existing peers. General repair of previously drifted topology remains under development.

## Model

- A **device** is a trusted desktop, laptop, or phone where the vault is available in plaintext and actively used in Obsidian.
- A **shard** is an always-online Syncthing instance that stores only Syncthing's Receive Encrypted representation of the vault.
- Devices form normal Syncthing shares with other devices.
- Every device uses the same shard encryption key when sharing with a shard.
- A shard is marked untrusted by devices and its folder type is always `receiveencrypted`.
- Shard-to-shard links exchange the ciphertext already stored on disk and do not receive the key.

With `n` instances, the complete mesh contains `n(n-1)/2` peer relationships. Tephramesh builds this plan deterministically so adding one instance can eventually be reconciled across all existing instances.

See [the architecture notes](docs/architecture.md) for the trust matrix and planned idempotent reconciliation sequence.

## Current beta

- First-instance onboarding is restricted to `localhost`, `127.0.0.1`, or `::1`; the port is configurable.
- Remote API endpoints must use HTTPS. Device and shard setup accepts a complete Syncthing URL and derives protocol, hostname, port, and an optional reverse-proxy path; all REST calls and displayed links retain that path.
- Before Syncthing setup, Tephramesh generates a dedicated post-quantum age identity using hybrid ML-KEM-768 and X25519 encryption. It presents the private identity for secure backup before continuing. Importing an existing native age identity remains available as an alternative.
- The public recipient (`age1pq1…` for generated identities) and age-encrypted configuration sync with the vault; only the private identity is stored locally in Obsidian Keychain. The plaintext file contains just its schema version, public recipient, and ciphertext. All folder, instance, endpoint, device, status-setting, fingerprint, and secret data is inside the ciphertext.
- Syncthing API keys and the shard encryption key live inside that age-encrypted bundle. A newly synced Obsidian installation imports the private identity once and then receives all Tephramesh-managed secrets through the vault.
- Syncthing remains authoritative for device names; Tephramesh checks every instance approximately every five minutes and persists external name changes.
- The Tephramesh folder label is desired state: changes are propagated to every reachable Syncthing instance and retried during periodic refresh when an instance is unavailable.
- Encryption setup automatically generates the shard encryption key with an `sk-` prefix and 32 cryptographically random, unbiased alphanumeric characters. Its SHA-256 hash remains available as a fingerprint inside the encrypted operational configuration.
- Device identity is verified against `/rest/system/status`.
- Test performs read-only validation; Add creates a missing folder from Syncthing's default-folder template.
- Before Add changes an existing mesh, every registered instance must be reachable, idle, fully synchronized, and free of reported folder errors. A failed check blocks Add and requires another successful Test.
- Add configures the new instance and every existing instance as bidirectional Syncthing device and folder peers, preventing the new managed folder from remaining Unshared.
- Removing a non-primary instance requires confirmation, stops sharing the managed folder from remaining peers, and removes its Syncthing folder configuration. Existing files at that instance's folder path remain on disk.
- Live folder state, local/global file counts, and pending files are shown in settings. Idle status is green; scanning and syncing are Syncthing-like light blue. Scanning also shows its event-backed percentage.
- The topology preview validates full-mesh folder modes, untrusted-device flags, and encryption-password placement, and shows the highest live global-file count reported by the mesh.

The encrypted configuration is safe to copy with `.obsidian/plugins/tephramesh/data.json`; its protected contents are held in plaintext only in memory while Tephramesh is unlocked. Each Obsidian installation needs one local Keychain entry named `tephramesh-age-identity`. External settings changes reload and decrypt the latest synced configuration automatically when that identity is available. Schema-2 beta data migrates to the fully encrypted schema automatically after unlock.

## Install with BRAT

Once a beta release exists:

1. Install and enable BRAT in Obsidian.
2. Add `https://github.com/willjasen/tephramesh` as a beta plugin.
3. Enable Tephramesh.
4. Open **Settings → Tephramesh**.

Tephramesh requires Obsidian 1.11.5 or later because that is the first public release where Keychain secrets are encrypted at rest.

## First setup

1. Select **Generate and continue** to create a post-quantum age identity locally, then copy and securely back up the private identity. Alternatively, import an existing native age key pair.
2. Tephramesh stores the private identity only in this app's Keychain. Enter that identity once when setting up Tephramesh on another Obsidian installation.
3. Run Syncthing locally and create or copy its API key.
4. Choose **Connect localhost** and paste the API key. Tephramesh discovers the device name from Syncthing.
5. Confirm the detected vault path, select **Test**, then **Add**. Tephramesh creates the Syncthing folder if it does not already exist.
6. The shard encryption key is already generated and protected as part of age setup; no separate Keychain configuration is required before registering a shard.

The API key is added to the age-encrypted bundle. The folder is created from Syncthing's own default-folder template, retaining the instance's default settings while assigning the Tephramesh folder ID, label, path, and folder type.

## Development

```bash
npm install
npm test
npm run build
```

To build and copy the plugin directly into the default `testing` vault:

```bash
./test.sh build
```

The build option installs locked dependencies, builds the plugin, and copies `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/tephramesh`. It does not replace `data.json`, so local Tephramesh settings are preserved. The same command is also available as `npm run deploy:test`.

To remove the plugin configuration and repeat onboarding from scratch:

```bash
./test.sh clear
```

This removes only `.obsidian/plugins/tephramesh/data.json`, then automatically builds and redeploys the current plugin. Unrelated vault data is preserved. The local `tephramesh-age-identity` Keychain entry is stored separately and cannot be removed by the script. Reload Obsidian, or disable and re-enable Tephramesh, before beginning the fresh setup. The same command is available as `npm run clear:test`.

To deploy to a different testing vault without editing the script:

```bash
TEPHRAMESH_TEST_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/tephramesh" ./test.sh build
```

The release workflow attaches `main.js`, `manifest.json`, and `styles.css` to version tags, which supports BRAT and matches the artifacts required for an eventual Obsidian community-plugin submission.

## Roadmap

- Read existing device/folder configuration and show a per-instance change preview.
- Expand the idempotent `/rest/config/devices` and `/rest/config/folders` reconciliation used during Add into a general topology repair operation while preserving unrelated Syncthing configuration.
- Verify config consistency and folder health after each instance, stopping and rolling forward safely on failure.
- Support local participation: each Obsidian device applies its own localhost plan while a chosen controller manages headless shards.
- Add guided recovery for lost shard encryption keys, replaced devices, and partially completed reconciliation.
- Complete Obsidian community-plugin policy review and submission.

## Security notes

- Syncthing's GUI/API should normally remain bound to localhost. If a remote API is required, put it behind authenticated HTTPS and network-level access controls; an API key grants administrative control over Syncthing.
- Do not expose port 8384 directly to the public internet.
- Back up the age private identity, shard encryption key, and Syncthing folder ID securely. Losing the age identity prevents Tephramesh from recovering the synced secret bundle; the shard key and folder ID are needed for disaster recovery from encrypted shard data.
- Shard encryption hides file names and contents, but not the folder ID/label or approximate file sizes.

## License

Copyright © 2026 willjasen.

Tephramesh is free software licensed under the [GNU General Public License, version 3 only](LICENSE) (`GPL-3.0-only`). Distributed modified versions and derivative works must remain under GPLv3 and make their corresponding source available under the license's terms.
