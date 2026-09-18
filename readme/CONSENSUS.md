# Cooperation between installations

Tephramesh coordinates multiple Obsidian installations through a shared
Syncthing mesh. The installations cooperate by replicating one encrypted
configuration, validating signed revisions, and reporting which installations
have accepted the current revision.

This is convergence, not a majority-vote consensus algorithm. Tephramesh does
not elect a leader, count a quorum before every save, or automatically merge
two competing edits. Cryptographic signatures and explicit conflict handling
prevent one installation from silently overwriting another branch.

## The participants

- An **Obsidian installation** runs the Tephramesh plugin and may represent an
  active Device or a Known device. It can hold a local age identity and, after
  enrollment, a private device-signing key.
- A **Device** runs Obsidian and stores the vault in plaintext. Device managed
  folders use Syncthing `sendreceive`.
- A **Shard** is generally always online and stores Syncthing's encrypted
  representation of the managed folder. Its folder uses `receiveencrypted`.
  Shards participate in synchronization but cannot enroll device-signing keys.
- **Syncthing** transports vault data and Tephramesh's `.obsidian` files
  between configured peers. It is the replication layer, not the authority for
  Tephramesh configuration authorization.

The intended topology is a complete mesh. With `n` active instances, the mesh
has $n(n-1)/2$ peer relationships. Tephramesh configures each relationship in
both directions and applies the appropriate device-to-device or shard policy.

## Configuration convergence

The normal flow for a configuration change is:

1. An enrolled installation changes local operational settings.
2. Tephramesh creates or extends the protected configuration history.
3. The installation signs a new monotonic configuration revision.
4. It writes an encrypted signed `data.json` and preserves a local journal
   record before replacing the authoritative file.
5. Syncthing replicates the changed Tephramesh subpath to other active Devices.
6. Each receiving installation decrypts the file, verifies the history and
   enrollment chain, checks continuity from its last accepted revision, and
   loads the configuration if valid.
7. Each installation writes a signed acknowledgement for the exact revision
   and envelope hash it loaded.

The originating installation asks its local Syncthing device to scan the
Tephramesh configuration subpath immediately. Other active devices are asked
to scan after a short delay so the originating index update has time to
propagate. These scans accelerate discovery; normal Syncthing watching and
scheduled scans remain authoritative.

## Enrollment is separate from mesh membership

Being present in the Syncthing mesh does not automatically authorize an
installation to sign configuration. A device or Known device must be enrolled
through the manual request and approval process described in
[SIGNING.md](SIGNING.md). This allows an Obsidian phone or other installation
without a queryable Syncthing API to participate in configuration signing.

The private age identity lets an installation decrypt the shared configuration.
The private device-signing key lets an enrolled installation authorize a new
revision. Both credentials remain local to that installation.

## Intermittently connected iPhone signers

An iPhone running Obsidian can be an enrolled signer even when it does not
expose a queryable Syncthing API. It should be treated as an intermittently
connected participant, not as a continuously available quorum member.

The important distinction is:

- **Signing authority:** the iPhone may sign a configuration revision while
  Obsidian is open, the configuration is unlocked, and its local signing key is
  valid.
- **Replication availability:** the iPhone may not receive a new `data.json`,
  acknowledgement, or confirmation until Syncthing runs in the foreground or
  otherwise completes a background sync permitted by iOS.
- **Acceptance evidence:** the iPhone counts as current only after it has
  actually decrypted and verified the revision. Its local UI may count that
  acceptance immediately, but other installations should count it as observed
  only after the signed acknowledgement has replicated. An old last-seen
  timestamp must not be treated as a current acceptance.

Desktop installations should not wait for the iPhone before saving a normal
configuration change. They can save the next signed revision while the iPhone
is offline; the iPhone remains behind and its Signing status stays pending
until it reconnects, receives the revision, verifies it, and publishes its
acknowledgement. The same rule applies in the other direction when the iPhone
creates a change: the change becomes available to other installations only
after its encrypted signed `data.json` reaches the mesh.

The foreground recovery flow for the iPhone is therefore:

1. Open Obsidian and unlock Tephramesh if required.
2. Allow Syncthing to exchange the current encrypted configuration and
   acknowledgement directories.
3. Let Tephramesh verify the newest accepted revision and write a fresh signed
   acknowledgement and observation.
4. Keep the app and Syncthing active long enough for those files to replicate
   back to the other installations.

An iPhone that edits while disconnected can create a same-revision conflict
with a desktop that edited independently. Tephramesh must keep rejecting that
ambiguous branch rather than choosing whichever file arrives first. The user
then explicitly keeps one branch, which is saved as a later signed revision.

This model gives mobile installations meaningful signing authority without
pretending that iOS background execution provides reliable consensus
participation. For a stronger mobile workflow, a future implementation could
add an explicit “mobile offline” status and a foreground “sync and verify”
action, but neither should weaken revision, signature, or acknowledgement
validation.

## Acceptance reporting

Acceptance has two stages of observation:

- An acknowledgement says, “this installation verified and loaded revision X.”
- A confirmation says, “this installation has observed the acknowledgements
  from these enrolled installations.”

The files are replicated through the mesh under the current configuration
acknowledgement directory. Tephramesh verifies each file against the current
root, revision, envelope hash, active enrollment records, and signatures before
counting it.

The Signing tab presents these as:

- **Using this configuration:** how many enrolled installations acknowledged
  the exact current revision;
- **Know this device is up to date:** how many enrolled installations have
  confirmed seeing this installation's acknowledgement.

The local installation counts its own acceptance immediately. Peer propagation
must be demonstrated by a verified confirmation file. A green complete state
therefore means both that every enrolled installation accepted the current
revision and that every enrolled installation reported seeing this installation
accept it.

## What happens when installations disagree

If two installations independently produce different signed envelopes at the
same revision, the receiving installation detects a same-revision, different-
hash conflict. It does not choose a branch based on arrival order or on which
host is online first.

Normal configuration saves pause and the conflict remains visible. The user
can explicitly keep the currently synchronized branch; Tephramesh then signs
the same protected contents as the next revision. Choosing and merging an
alternate journal branch is not automatic.

This design means temporary disconnection does not require a live quorum, but
it also means conflicting concurrent edits require an explicit human decision.

## Mesh repair and safety gates

Adding or repairing a mesh is more restrictive than ordinary file replication.
Before adding an instance, Tephramesh checks that existing active instances are
reachable, idle, fully synchronized, and free of folder errors. It blocks the
change when that safety gate fails.

Reconciliation inspects identities, devices, folders, pending invitations,
and managed-folder state. Repair is enabled only when hosts are reachable and
the plan is unambiguous and safe. Repair is idempotent and verified, preserves
unrelated Syncthing configuration, and reports partial failures instead of
pretending the mesh is converged.

Syncthing peer trust involving a Shard is left unchanged. Device-to-device
trust and folder sharing are managed according to the Tephramesh mesh policy;
shard-to-shard links exchange ciphertext already stored by their encrypted
folders.

## Availability and stale state

Each host is checked independently. A slow host is bounded by the configured
offline timeout, while checks for healthy hosts continue. Timed-out Syncthing
requests are retained and reused because Obsidian's request API cannot abort
them safely.

An unavailable host does not invalidate already verified configuration data in
memory, but it prevents Tephramesh from claiming that the active mesh is fully
healthy. Acceptance and confirmation refreshes retry after connectivity returns.

## Security boundary

Syncthing supplies replication and transport encryption. Age supplies
confidentiality for the Tephramesh configuration. Device signing supplies
authorization and revision continuity. No single layer is treated as a
replacement for the others, and the plugin never claims that an acknowledgement
proves delivery to a non-enrolled device.
