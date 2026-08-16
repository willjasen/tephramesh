# Tephramesh agent guide

Keep this file current. Every feature, behavior change, important fix, renamed concept, new invariant, or workflow change must update `AGENTS.md` in the same work. Describe shipped behavior as current and unfinished behavior as pending; never blur the two.

## Product

Tephramesh is an Obsidian plugin that manages a dedicated Syncthing mesh for exactly one complete Obsidian vault.

- A **device** is a trusted desktop, laptop, or phone that runs Obsidian and stores the vault in plaintext.
- A **shard** is a generally always-online server. Its managed folder must be Syncthing `receiveencrypted`; devices mark it untrusted and provide the shard encryption key when sharing.
- Devices use `sendreceive`. Device-to-device data is plaintext at rest and encrypted in transit by Syncthing.
- All devices use one **shard encryption key**. Do not call it a shared password or shard password in user-facing text.
- The intended topology is a complete mesh with `n(n-1)/2` peer relationships.
- The entire vault is always in scope. Do not add selective-sync or exclusion UI. Pending: inspect every managed folder's Syncthing ignore rules and treat active rules as a warning or invalid plan, with a safe way to clear them. Syncthing's own internal files are exempt.

## Security and secrets

- First-instance onboarding may contact only loopback (`localhost`, `127.0.0.1`, or `::1`); its port is configurable.
- Remote Syncthing API endpoints require HTTPS. Store endpoints as protocol, hostname, port, and optional normalized URL path. Legacy endpoints without `path` mean the origin root.
- Encryption setup precedes Syncthing onboarding. When no encrypted plugin configuration exists, the only setup path locally generates a dedicated post-quantum hybrid age identity (`AGE-SECRET-KEY-PQ-1…`) using ML-KEM-768 plus X25519 and shows a one-time backup dialog before continuing. Do not show an existing-identity/public-recipient import form during fresh setup: there is no configuration whose recipient it could recover. When an encrypted configuration already exists, its plaintext public recipient is authoritative and the unlock screen asks only for the matching private identity. Do not accept SSH identities or passphrase encryption.
- Label the fresh encryption/onboarding screen **Tephramesh initial setup** and introduce it with: “Generate a dedicated post-quantum age identity to protect the plugin configuration.”
- The plaintext `data.json` envelope contains only `schemaVersion`, the public `ageRecipient`, and Base64 `encryptedData`. The decrypted versioned payload contains all operational settings and secrets: onboarding state, folder metadata, polling settings, complete instance records, API keys keyed by instance ID, the shard encryption key, and its fingerprint. Never add another plaintext configuration field without explicit user approval.
- Store only the private age identity in local Obsidian Keychain under the fixed ID `tephramesh-age-identity`. Never sync or write that identity to `data.json`. Clear decrypted secrets from memory on unload.
- A newly synced installation must show the unlock/import screen until the matching identity is entered once. Validate that the identity derives the configured recipient before storing it. Reload and decrypt externally synced settings through `onExternalSettingsChange`.
- Migrate legacy per-secret Keychain data into the encrypted bundle during encryption setup, remove legacy secret-name fields from saved configuration, and fail safely if a required legacy API key is unavailable. Old Keychain values cannot be programmatically deleted.
- API keys authenticate REST calls, not the normal Syncthing web UI. Never place an API key in a URL.
- Generated shard keys are `sk-` followed by 32 cryptographically random alphanumeric characters.
- Successful age setup automatically generates the shard encryption key before the first encrypted save. Legacy migration preserves an existing shard key and only generates one when none previously existed.
- Store the generated shard key inside the age-encrypted bundle and its lowercase SHA-256 fingerprint as `shardEncryptionKeyHash`. Once it exists, show it masked and disabled and expose no replacement control. If only a fingerprint exists, do not offer generation.

## Current behavior

- Settings use tabs: **Topology** first and selected by default, then **Instances** and **Vault**. There is no Shards tab or shard-key display: the key is generated automatically during age setup, remains hidden in encrypted configuration, and shard management stays in Instances.
- Initial setup asks for the API key, not a device name. Tephramesh discovers the local name by matching `/rest/system/status` `myID` to `/rest/config/devices`.
- Device and shard setup puts a complete Syncthing URL first. Parsing it must populate and visibly synchronize protocol, hostname, effective port (80/443 when omitted), and normalized reverse-proxy path. Component edits update the full URL. Reject credentials, query strings, fragments, unsupported schemes, and invalid URLs. `endpointUrl()` must include the path so both REST requests and clickable instance links work behind a subpath proxy.
- Device names remain Syncthing-authoritative. Refresh them from reachable instances approximately every five minutes and persist external changes.
- Setup has separate **Test** and **Add** actions. Add stays disabled until the current form state has passed Test; any edit invalidates the test result.
- For additional instances, the folder-path field starts disabled. A successful Test preserves an existing managed-folder path or suggests `<default Syncthing folder path>/<Tephramesh folder ID>`, then enables the field for review. Endpoint or API-key changes clear and relock the suggestion.
- Add creates a missing managed Syncthing folder from `/rest/config/defaults/folder`, posts it through the REST API, and verifies creation. Users should not need the Syncthing web UI for folder creation.
- Before adding another instance, perform a fresh status check against every existing instance. Block without mutation and show a warning unless all are reachable, `idle`, have no pending files/bytes, and report no folder errors.
- After the safety gate, configure the new and every existing instance bidirectionally as Syncthing devices and managed-folder peers. This includes direct sharing between every pair of shards when a second or later shard is added. The newly created folder must be shared immediately rather than left `Unshared`; apply the shard trust flag and encryption key only in the trusted-device-to-shard direction. Shard-to-shard peers are trusted Syncthing peers and receive no encryption key because they exchange ciphertext already stored by their `receiveencrypted` folders. Use the shared `meshPeerPolicy()` for both plans and live reconciliation, and verify every device and folder update by reading it back.
- Removing a non-primary instance requires explicit confirmation. Verify all affected APIs first, remove that device from the remaining managed-folder shares, delete the managed folder configuration on the selected Syncthing instance, verify each change, and only then forget it in plugin settings. Syncthing folder removal does not delete the files on disk; say so clearly in the warning and success notice.
- New folder IDs are `tephramesh-` plus eight lowercase alphanumeric characters. Never change an existing configured folder ID.
- Folder labels are desired state. Debounce edits, update every reachable instance, verify by reading back, warn about partial success, and retry during status refresh.
- The default status refresh interval is one second; options are 1, 5, 10, 30, and 60 seconds.
- Folder status uses green for idle and Syncthing-like light blue for scanning or syncing. Scanning shows event-backed percentage from `FolderScanProgress`; stale events older than `stateChanged` are ignored. Syncing shows a live integer completion percentage derived from global and needed bytes, falling back to global and needed file counts when byte totals are unavailable; floor incomplete values so they never display as 100% prematurely. The syncing line also shows instance-wide download and upload rates calculated between consecutive `/rest/system/connections` cumulative-byte samples. Sample traffic during every status refresh, including idle periods; show `measuring…` until a valid prior sample exists and after counters reset. These rates intentionally include traffic from every Syncthing folder on the instance.
- Instance cards show a compact `Device` or `Shard` role badge followed by the Syncthing-authoritative name, the first seven-character device-ID segment, and the live Syncthing version together in the heading. Show only the returned version string (for example, `v2.1.2`), without a `Syncthing` prefix. Device badges use Obsidian's active purple accent; shard badges use orange so they remain distinct from blue scanning/syncing states. Both use high-contrast accent text. Do not render the role as a plain `Device: ` or `Shard: ` text prefix. The version updates with normal status refreshes and uses a neutral placeholder until known. Retain the full device ID internally.
- Instance URLs appear alone on the next line, are clickable, use Obsidian's link/accent color, and never embed credentials.
- Every instance has an Edit URL action. The edit dialog may change only protocol, hostname, port, and reverse-proxy path; it reuses the protected API key and never changes the instance ID, kind, folder path, or full Syncthing device ID. Save remains disabled until Test succeeds for the exact current endpoint and `/rest/system/status` reports the instance's existing full device ID. Any URL/component edit invalidates the test. Apply and persist the endpoint only after that identity check.
- Notices use a colored first line: green success, yellow warning, red error.
- The Topology tab has a validation header, aggregate live mesh status, separate device/shard/connection/global-file metrics, storage behavior, and responsive layout. Aggregate status is unavailable when an instance fails, otherwise prioritizes scanning over syncing, and reports idle only when every configured folder is idle; use the same green/blue/red status colors as instance cards. Global files is the highest finite live `globalFiles` count reported by a reachable instance, or an em dash before status is available. Adding an instance now reconciles that new instance with every existing peer; broader repair/reconciliation of previously drifted topology remains pending.

## Implementation map

- `src/main.ts`: lifecycle, settings persistence, polling, device-name reconciliation, and folder-label propagation.
- `src/settings-tab.ts`: tabbed settings, instance/status UI, shard-key UI, and topology summary.
- `src/instance-modal.ts`: setup, Test/Add gating, device discovery, and folder creation flow.
- `src/edit-endpoint-modal.ts`: endpoint-only editing with Test/Save gating and full device-ID identity verification.
- `src/remove-instance-modal.ts`: destructive-removal confirmation and failure handling.
- `src/syncthing-client.ts`: Syncthing REST client.
- `src/security.ts`: endpoint validation, identifiers, key generation/validation, shortening, and SHA-256 hashing.
- `src/secret-bundle.ts`: native age key-pair validation, versioned secret-bundle encryption/decryption, and the fixed local identity name.
- `src/age-identity-backup-modal.ts`: one-time private-identity backup and clipboard UI after generation.
- `src/topology.ts`: deterministic full-mesh planning and trust/encryption placement.
- `src/syncthing-device.ts`, `src/syncthing-folder.ts`, `src/syncthing-scan.ts`: pure helpers with focused tests.
- `src/notices.ts`: severity-colored notices.
- `styles.css`: settings, topology, status, links, and notice presentation.
- `docs/architecture.md`: trust matrix and planned reconciliation sequence.

## Development and release workflow

- License: GPL-3.0-only.
- Required validation for code changes: run `npm test` and `npm run build`. The current baseline is 37 tests across eight test files; update this count here only when it materially helps orientation.
- `main.js` is a generated production bundle and is intentionally ignored by Git. It is still required by Obsidian, BRAT, and community-plugin releases: local build/deploy creates it, and the tag-based release workflow rebuilds and attaches it alongside `manifest.json` and `styles.css`.
- Ignore machine-local/generated files: `node_modules/`, `main.js`, source maps, TypeScript build metadata, coverage, logs, `.env` variants except `.env.example`, `.idea/`, `.vscode/`, `.DS_Store`, and any root `data.json`. Never commit plugin runtime configuration even though its protected payload is age-encrypted. Commit the lockfile, manifest, versions map, stylesheet, source, tests, documentation, and release workflow.
- `./test.sh build` installs locked dependencies, builds, and copies `main.js`, `manifest.json`, and `styles.css` to the testing vault. It preserves plugin `data.json`.
- `./test.sh clear` removes only the testing vault's Tephramesh `data.json`, then automatically performs the build/deploy flow. It cannot remove the local `tephramesh-age-identity` Keychain entry.
- Default testing destination: `/Users/willjasen/Library/Mobile Documents/iCloud~md~obsidian/Documents/testing/.obsidian/plugins/tephramesh`. Override with `TEPHRAMESH_TEST_PLUGIN_DIR`.
- Preserve unrelated user changes and do not delete or rewrite existing configuration without an explicit migration or request.
