# @guild/persistence

Main-process-only authoritative persistence for Guild aggregates. The public
surface accepts domain commands and events, never renderer-owned aggregate
snapshots, SQL, database handles, or arbitrary transactions.

Schema v1 stores canonical Run and SessionBinding records plus permission
decisions and their exact-response outbox. The forward-only v2 migration adds
workspace-owned task metadata, conversation entries, drafts, adapter/prompt
correlation, and the singleton application settings row. SQLite is opened in WAL
mode with `synchronous=FULL`, foreign keys, defensive mode, disabled trusted
schema, integrity checks, and a clean-shutdown marker. A private sidecar SQLite
connection holds an OS-backed exclusive lock for the canonical path, while the
authoritative database connection holds a second exclusive lock on the actual
database inode and performs every application read and write. This dual lock
keeps path replacement and inode aliasing as separate failure domains. A
filesystem owner record is durable crash evidence only; process liveness never
depends on a reusable PID. Recovery evidence is cleared only after a later
clean close.

Both database connections are internal lease state. The lease is their only
close owner, and it closes the authoritative connection before closing the path
guard. While a store is live, no other Guild code may raw-open, copy, rename,
unlink, or inspect either SQLite file because POSIX advisory locks are
process-scoped. Future backups must use SQLite's connection-aware backup API,
not filesystem copying. Persistence is restricted to one main-thread realm and
two process-wide registries keyed by canonical guard path and database inode.
Packaged validation must also prove that the chosen local filesystem implements
SQLite locking correctly; network filesystems are not accepted by this slice.
The packaged app owns a private local data directory. Moving or replacing the
database, guard, or containing directory while Guild is running is unsupported;
backup, restore, and relocation must first quiesce the store or use a future
connection-aware maintenance API. The dual lock deliberately tolerates one
component being moved, but it is not a named OS mutex against a coordinated
replacement of the entire live storage generation.

On POSIX systems, opening and closing another descriptor for a locked inode can
drop every advisory lock that process holds on that inode. The second lock
contains a one-file mistake, but raw-opening both SQLite files can defeat both
locks. Any production integration that accesses either live file outside this
lease is therefore a release blocker, even when the access is read-only.

Ordinary permission registration always creates a pending permission and
persists its exact `Run.permission_admitted` event in the same immediate
transaction. Cancel-time registration has a separate API that atomically
persists the Run event, immutable automatic decision, pending outbox row, and
exact delivery claim before returning one write command. Exact late ACKs remain
valid after a durably recorded `delivery_uncertain` transition. Run
terminalization and Permission closure share one transaction: every unresolved
Permission is closed, and any exact response still `in_flight` becomes
`delivery_uncertain`, including automatic and cancel-time safe responses that
were never present in the Run's unresolved set.

Electron callers are rejected unless `process.type` is `browser`; ordinary Node
processes remain allowed for migrations, maintenance, and tests. Renderer and
utility processes must call a narrow main-process facade instead.

## Workspace, task, and conversation authority

`createConversationTask` commits a new task, its immutable workspace binding,
and its initial unbound session binding as one unit. Existing low-level task
records can be bound once through `bindTaskToWorkspace`; a later workspace
change is rejected. A workspace canonical path is inert persisted data here.
This package never resolves, stats, opens, watches, or grants that path. The
main-process workspace service must pass an already canonicalized value and
retain responsibility for access grants.

Workspace and task archive/delete actions are monotonic soft dispositions with
required revision compare-and-set. Listing keeps the workspace as the parent
and returns tasks only from that exact binding. Deleted or archived parents
remain loadable for history, while new conversation and draft writes require an
active task under an active workspace.

Conversation entries have task-local monotonically allocated sequence numbers
and idempotent entry IDs. They distinguish user, assistant, thought, tool,
permission, media, notice, and error records. Text is append-only while an entry
is streaming; terminal `complete` and `failed` states are monotonic. Entry text
is limited to 1 MiB UTF-8, one append to 256 KiB, canonical metadata to 64 KiB,
and list pages to 500 records. Draft writes and application-setting changes use
explicit revisions. The v2 settings row defaults to Simplified Chinese, a
280-pixel sidebar, and browser synchronization disabled; changing the stored
preference does not itself access a browser or Keychain.

## Live adapter commits

Adapter epochs are durable, never-rebound task/session identities with monotonic
status. Prompt acceptance atomically records `(task, Run, session, epoch,
promptSequence)` and the Run `prompt_accepted` transition. Once accepted,
`commitLiveRuntimeEvent` rebuilds the admission context from authoritative
SQLite records, default-denies stale or out-of-order events, and commits one
validated live envelope together with exactly one typed conversation mutation.
Terminal commits also finalize the prompt correlation and Run in that same
unit. A failed conversation compare-and-set therefore cannot leave a committed
envelope or terminal Run behind, and an exact event retry cannot append twice.

Replay-to-history is deliberately not exposed by this basic live commit API.
Replay remains a staging-only product gap until a separate reconciler can prove
its task/session mapping; it never invents a Run identity.

`node:sqlite` requires the pinned Electron runtime to embed Node 24.12 or newer.
Packaged-app, forced-kill, power-loss, and Windows filesystem validation remain
release gates outside this package's unit suite.
