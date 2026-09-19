# Guild 2 authoritative state machines

## Scope and invariants

This document defines domain behavior only. It does not change the accepted Guild 1.1.13 UI.
Visible state labels, geometry and interactions remain governed by the black-box parity contract.

The machines below are orthogonal. A power transition does not overwrite a Run state; transport
recovery does not restore a finished Run; and a session replacement does not silently rebind a task.
All state-changing operations are serialized by the authoritative main-process store and are
idempotent by event key.

Identifiers are immutable values, not display labels:

- `taskId` identifies the durable Guild task.
- `runId` identifies exactly one prompt invocation.
- `sessionId` is the opaque runtime session bound to the task.
- `adapterEpoch` is a monotonically increasing, never-reused process generation.
- `toolCallId` identifies one runtime tool call within a session/Run.
- `windowId` identifies the renderer window authorized to act on a permission request.

Every normalized runtime envelope carries `taskId`, `runId`, `sessionId`, `adapterEpoch`,
`ingestMode` (`live` or `replay`), a Guild-assigned monotonic receive sequence and the raw protocol
identifier when one exists. Tool and permission envelopes also carry `toolCallId`. Protocol message
IDs are optional evidence and are never assumed stable across load.

Unless a transition appears in a table below it is illegal and must be rejected without mutating
durable state. Repeated delivery of the same idempotency key returns the first result.

## 1. Run state machine

### States

| State | Meaning |
|---|---|
| `queued` | Durable invocation exists but owns no process activity. |
| `starting` | Dispatch began; process/session checks or prompt submission are in progress. |
| `running` | The runtime accepted the prompt and may emit live updates. |
| `awaiting_permission` | The Run is live but blocked on one or more exact permission requests. |
| `completing` | A terminal runtime result is being validated and committed with final output. |
| `cancel_requested` | Durable cancel intent exists; termination has not yet been proven. |
| `completed` | Final output and successful terminal outcome committed. |
| `failed` | A non-interruption failure committed, including launch failure or rejected final commit. |
| `cancelled` | Cancellation termination was proven after durable cancel intent. |
| `interrupted` | An active Run lost its process/transport or application ownership before a durable terminal result. |

`completed`, `failed`, `cancelled` and `interrupted` are terminal and absorbing. Recovery may make
the task/session usable again, but it never changes these Run rows. A later user send always creates
a new `runId`.

The Run's unresolved-permission authority is the exact six-field permission identity set, not a
count. Permission callback, admitted, resolved, denied and expired events carry that identity,
include it in their fingerprints, and exact-match the Run's `taskId`, `runId`, `sessionId` and
`adapterEpoch`. A repeated identity with a different delivery event key does not add a second
unresolved entry or repeat effects. Resolution removes only that identity: remaining identities keep
`awaiting_permission`; the last returns `running`. Unknown or mismatched resolution is rejected
without mutation. Terminal outcomes and terminal-response staging clear the set atomically, so
`completed`, `failed`, `cancelled`, `interrupted` and `completing` never retain actionable unresolved
permissions. A permission request while `cancel_requested` persists the existing safe-cancel intent
and does not add an actionable unresolved identity.

### Legal transitions

| From | Event / guard | To | Required atomic effects |
|---|---|---|---|
| `queued` | scheduler dispatches while task/workspace/session intent still matches | `starting` | Record dispatch attempt and intended epoch/session. |
| `queued` | user requests cancel | `cancelled` | Persist cancel intent and local not-dispatched proof in one authoritative transaction. That proof is valid cancellation evidence; writing a cancel notification is not required and is not itself proof. |
| `starting` | runtime accepts prompt | `running` | Persist runtime prompt correlation before admitting updates. |
| `starting` | user requests cancel | `cancel_requested` | Persist intent before any cancel notification or owned-process stop. |
| `starting` | validation, authentication, spawn or prompt submission fails before ownership becomes live | `failed` | Persist diagnostic category; do not invent a runtime terminal response. |
| `starting` | owned process exits/EOF occurs after prompt submission may have begun | `interrupted` | Persist process/transport reason and close the epoch. |
| `running` | exact permission callback is admitted | `awaiting_permission` | Persist request and exact identity before exposure to its authorized window. |
| `awaiting_permission` | a distinct exact permission is admitted | `awaiting_permission` | Persist the additional request; the unresolved identity set keeps every exact identity. |
| `awaiting_permission` | exact request resolves (selected allow/rejection, cancelled, expired, or orphaned) | `running` when no identities remain, otherwise `awaiting_permission` | Persist exactly-once resolution; remove only that identity. Unknown or mismatched identity is rejected. |
| `running` or `awaiting_permission` | successful terminal response admitted | `completing` | Stage terminal response and final records, and clear the unresolved identity set, in one transaction. |
| `running` or `awaiting_permission` | protocol-level terminal error with healthy ownership | `failed` | Persist the explicit error and close pending permissions, clearing the unresolved identity set. |
| `running` or `awaiting_permission` | user requests cancel | `cancel_requested` | Persist intent before writing the cancel notification. |
| `completing` | final message and outcome transaction commits | `completed` | Commit final output and terminal transition atomically. |
| `completing` | final validation/storage transaction fails | `failed` | Persist recoverable failure if storage is available; never show completed. |
| `completing` | cancel intent wins serialization before terminal commit | `cancel_requested` | Persist intent; discard or quarantine the uncommitted completion stage. |
| `cancel_requested` | runtime terminal response explicitly confirms cancellation | `cancelled` | Close pending permissions, clear the unresolved identity set, and commit terminal cancellation. |
| `cancel_requested` | owned process exit or forced-kill completion is confirmed | `cancelled` | Record proof, clear the unresolved identity set, and close the process epoch. Sending cancel alone is insufficient. |
| `cancel_requested` | normal successful terminal result won the race | `completing` | Stage the truthful result and clear the unresolved identity set; cancellation was too late. |
| `cancel_requested` | explicit non-cancellation terminal error won the race | `failed` | Preserve both prior cancel intent and actual terminal reason; clear the unresolved identity set. |
| `running`, `awaiting_permission` or `completing` | owned process death, terminal EOF, bounded liveness failure or quit teardown before durable completion | `interrupted` | Persist reason, expire/orphan permissions, clear the unresolved identity set, and close the epoch. |

Operational events that intentionally do not change Run state:

| Event | Run effect |
|---|---|
| renderer reload/window loss | No transition. Authoritative work remains in main; permissions for that `windowId` become orphaned. |
| OS suspending/asleep/resuming | No transition. Power and recovery machines record it; the pre-sleep Run state remains known. |
| transient network or transport silence below the liveness bound | No transition. Transport may enter `suspect`. |
| application quit while `queued` | No transition. The durable un-dispatched Run may be scheduled after reopen. |
| permission denial | No automatic terminal transition. Follow the protocol: continue to `running`, or admit an explicit terminal response. |
| stale-process or wrong-identity event | Reject and audit; no transition or content mutation. |
| exact live `session/update` while `cancel_requested` | Admit and persist chronological output while the original prompt is still pending; do not undo cancel intent or claim terminal cancellation. |
| permission request while `cancel_requested` | Persist the exact request and send one exact safe response: the first advertised `reject_once`, otherwise ACP `cancelled`; never auto-select `reject_always`, expose a fresh action, or add an actionable unresolved identity. |

Cancellation escalation is topology-aware. After a bounded grace period, Guild may terminate only
the process owned by the Run according to the accepted Phase 0 topology. If a topology shares a
process, the spike must prove a safe isolation mechanism before process termination can be used.

### Explicitly illegal Run transitions

The default-deny rule covers all unlisted pairs. These cases are called out because accepting them
would create false product behavior:

- `running -> completed` without the durable `completing` transaction;
- any non-terminal state directly to `cancelled` merely because a cancel notification was written
  (a queued Run may become `cancelled` only when the same authoritative transaction records local
  not-dispatched proof, which is distinct from writing a cancel notification);
- `interrupted -> running`, including after transport reconnect, session resume or session load;
- any terminal state to any other state;
- any state change caused only by renderer loss, suspend/resume, replay data or a stale epoch;
- permission resolution with a partial identity, a different window, or an identity that is not in
  the Run's unresolved set;
- changing a Run's `taskId`, `sessionId` or `adapterEpoch` after prompt acceptance.

## 2. SessionBinding state machine

SessionBinding belongs to a task and is independent of every Run.

| State | Meaning |
|---|---|
| `unbound` | The task has no runtime session. |
| `creating` | An explicit new-session operation is in progress. |
| `healthy` | The task is bound to one proven usable `sessionId`. |
| `restore_pending` | The same opaque session may be restorable on a new adapter epoch. |
| `replay_reconciling` | `session/load` is emitting staged replay behind a completion barrier. |
| `broken` | The retained session cannot currently be restored or its identity/integrity is uncertain. |
| `replacement_pending` | The user explicitly authorized replacement, but no new binding has committed. |

| From | Event / guard | To | Effects |
|---|---|---|---|
| `unbound` | authenticated runtime is ready and `session/new` is about to be sent | `creating` | Preserve intended task/workspace; allocate no fake session ID. Initialization or authentication failure before this point leaves the task `unbound` and safely retryable. |
| `creating` | `session/new` succeeds | `healthy` | Atomically bind the returned opaque session ID. |
| `creating` | `session/new` fails or its delivery/result is uncertain | `broken` | Retain local task and disclose failure. |
| `healthy` | owning transport is lost or app restarts | `restore_pending` | Retain local history and the same opaque session ID. |
| `restore_pending` | advertised `session/resume` succeeds | `healthy` | Bind the same session to the new current epoch; no replay admission opens. |
| `restore_pending` | advertised `session/load` begins | `replay_reconciling` | Open an isolated replay staging area and barrier. |
| `restore_pending` | restore unsupported, rejected, times out or identity mismatches | `broken` | Keep history; do not silently call `session/new`. |
| `replay_reconciling` | load-completion barrier passes and reconciliation has no unresolved conflict | `healthy` | Atomically commit the reconciliation verdict; then enable live admission. |
| `replay_reconciling` | malformed replay, missing barrier, timeout, conflict or epoch loss | `broken` | Discard/quarantine staging and keep durable local history unchanged. |
| `broken` | user explicitly authorizes replacement | `replacement_pending` | Record consent and the old broken binding. |
| `replacement_pending` | replacement creation begins | `creating` | Create a new session; do not mutate old Runs. |
| `replacement_pending` | user withdraws replacement | `broken` | Preserve the old broken binding and local history. |

Illegal examples include `broken -> healthy` without a proven restore, `broken -> creating` without
recorded user authorization, `replay_reconciling -> healthy` before its barrier, and changing
`sessionId` while remaining `healthy`. Task deletion may dispose a binding but is not a recovery
transition.

Restore order is: probe advertised capability, prefer `session/resume`, otherwise use proven
`session/load`, otherwise enter `broken`. Restoring a binding never resumes an in-flight Run.

A user-authorized replacement may become transport-healthy before it has semantic task context.
Guild therefore persists the semantic-recovery requirement before replacement creation begins; the
marker survives a process exit or model/mode configuration failure after `session/new` commits. The
first admitted prompt carries one bounded task-local recovery capsule. Guild records handoff completion
only after official prompt acceptance, and never consumes the marker when the combined capsule and
message exceed the ACP string bound. If no earlier user-authored task definition exists,
context-dependent text such as `continue` is rejected before Run creation; an explicit task definition
may establish the handoff. This admission rule is orthogonal to SessionBinding and never copies another
task's transcript or replays an old Run.

## 3. Process epoch state machine

An adapter epoch is allocated and persisted before each official process spawn. Epoch numbers are
monotonic per supervisor and never reused, including after failed spawn. Each process and its stdio
transport have exactly one epoch.

| State | Legal next state | Trigger |
|---|---|---|
| `absent` | `spawning` | Allocate new `adapterEpoch` and begin official process spawn. |
| `spawning` | `alive` | Expected binary and stdio ownership are confirmed. |
| `spawning` | `exited` | Spawn failure or immediate exit. |
| `alive` | `stopping` | Graceful shutdown, cancellation escalation or app quit begins. |
| `alive` | `exited` | Unexpected exit is observed. |
| `stopping` | `exited` | Exit or forced-kill completion is confirmed. |

`exited` is absorbing for that epoch. A respawn creates a new epoch in `spawning`; it never returns
the old epoch to `alive`. An event from an epoch other than the envelope owner's persisted epoch is
rejected before state or content handling.

## 4. Transport state machine

Transport state is scoped to one adapter epoch and does not encode Run or SessionBinding state.

| From | Event / guard | To |
|---|---|---|
| `detached` | process stdio attached | `initializing` |
| `initializing` | initialize succeeds and an advertised auth method is selected | `authenticating` |
| `initializing` | initialize fails, malformed frame or EOF | `failed` |
| `authenticating` | advertised authentication succeeds | `ready` |
| `authenticating` | authentication fails, EOF or bounded timeout | `failed` |
| `ready` | bounded silence threshold begins or power resumes pending probe | `suspect` |
| `suspect` | liveness probe and framing succeed in the same epoch | `ready` |
| `suspect` | liveness bound expires, malformed framing or EOF | `failed` |
| `ready` or `suspect` | orderly teardown begins | `closing` |
| `closing` | EOF/process exit confirmed | `closed` |
| any non-terminal transport state | owning process exits unexpectedly | `failed` |

`closed` and `failed` are terminal for that epoch. Reconnection requires a new adapter epoch and a
new `detached -> initializing` sequence. `ready` means protocol transport is usable; it does not mean
that any particular session is healthy or any prior Run can continue.

Initialization follows the proven official sequence: pin the executable identity, request automatic
update suppression when that installed binary supports the documented flag, `initialize`, choose
only an advertised authentication method, `authenticate`, then session work. An older binary that
does not advertise the flag must remain hash-stable for the epoch and cannot be hot-swapped under a
live Run. Guild never opens, parses, copies or logs the credential source.

## 5. Power and recovery state machines

### Power

| From | Event | To |
|---|---|---|
| `awake` | OS will suspend | `suspending` |
| `suspending` | OS reports sleep | `asleep` |
| `asleep` | OS reports wake | `resuming` |
| `resuming` | wake bookkeeping recorded | `awake` |

Duplicate OS notifications are idempotent. A missing intermediate notification may be synthesized
only from an authoritative OS observation and must record that reason. Power events do not directly
change Run, SessionBinding, permission or transport state.

### Recovery coordinator

| From | Event / guard | To |
|---|---|---|
| `idle` | wake, app reopen, renderer recovery or process/transport loss | `assessing` |
| `assessing` | current epoch and transport require repair | `transport_recovery` |
| `assessing` | transport is ready but session binding requires restore | `session_recovery` |
| `assessing` | no repair is required | `idle` |
| `transport_recovery` | a new epoch reaches transport `ready` | `session_recovery` |
| `transport_recovery` | bounded repair fails | `degraded` |
| `session_recovery` | SessionBinding reaches `healthy` | `idle` |
| `session_recovery` | SessionBinding reaches `broken` or repair times out | `degraded` |
| `degraded` | explicit retry or relevant external state changes | `assessing` |

On entering `assessing`, Guild snapshots the pre-sleep/pre-loss identities, terminalizes any active
Run whose owned process or transport was lost, expires or orphans affected permissions, and probes
the current epoch. Recovery success means the task can accept a new Run; it never means that an
interrupted Run changed back to running.

## 6. Permission identity and lifecycle

The permission identity is exactly:

```text
(taskId, runId, sessionId, toolCallId, adapterEpoch, windowId)
```

All six values are required and compared for exact equality. There are no wildcard, latest-window,
active-task or session-only lookups. The persisted request also retains the typed JSON-RPC callback
ID and exact ordered ACP `{optionId,name,kind}` list. The request row and identity are persisted before
UI notification. A response is persisted exactly once before its upstream write.
The first decision also creates an immutable `decisionCommit` binding its outcome, cause,
optional orphan cause, command ID, and initial outbox version. Later claim, loss, and exact flush
events retain that commitment byte-for-byte. Domain validation detects inconsistent snapshots;
it is not a cryptographic tamper proof. The authoritative SQLite repository must enforce a
`NULL -> exact decisionCommit` compare-and-set and must never accept a whole permission row from
the renderer.

| From | Event / guard | To |
|---|---|---|
| `pending` | exact callback resolves with an advertised option or ACP `cancelled` | `resolving` |
| `resolving` | exact response frame flush is acknowledged | `selected_allow`, `selected_rejection`, or `cancelled` |
| `pending` | bounded deadline passes | `expired` |
| `pending` | window closes/reloads, Run terminalizes, session changes, epoch exits or transport cannot reply | `orphaned` |
| `resolving` with a durable explicit response and unclaimed outbox | deadline, window close/reload, or other automatic-resolution signal while the owning transport can still write | `resolving` | Preserve the exact explicit response; never silently replace it with an automatic rejection. |
| `resolving` with an unclaimed outbox | permanent session/epoch/process loss before any write can begin | `orphaned` | Clear the unsent outbox, retain the persisted explicit resolution as audit truth, and do not claim delivery. |
| `in_flight` outbox | crash or permanent transport/epoch loss before ACK | `delivery_uncertain` |

Exact selected allow/rejection, `cancelled`, `expired`, and `orphaned` are terminal. A
`delivery_uncertain` command is terminal for scheduling and is never replayed; only a later exact
flush receipt for the same command/version/delivery attempt may refine it to the truthful selected
outcome without another write. Repeated resolution returns the stored result without a second runtime write. A wrong
identity/window/callback, stale epoch, unadvertised option, or terminal request is rejected and
audited. Automatic expiry/orphaning selects the first advertised `reject_once`; when none exists it
sends ACP `cancelled`, never `reject_always`. A dead transport creates no response command. Outbox
delivery is `pending -> in_flight -> completed|delivery_uncertain`; uncertain commands are never replayed.

## 7. Live and replay event admission

Production admission is default deny and accepts only a deeply frozen normalized turn payload paired
with its derived envelope. The package root does not expose raw-envelope admission. Admission happens
before messages, tools, permissions, Run state or SessionBinding can be mutated.

Every successful admission returns the revalidated, deeply frozen canonical pair as `result.event`.
Downstream code must discard the caller-supplied object and consume only `result.event`; failed
admission returns no event.

This boundary does not yet provide the first-frame transaction. The orchestration pass must atomically
persist `prompt_accepted` before admission and then delete the temporary
`starting + permission_request` allowance; until then, that allowance is not evidence of a complete
first-frame flow.

### Live admission

A `live` envelope is admitted only when all applicable conditions hold:

1. `ingestMode == live` and no replay barrier is open for the binding.
2. `adapterEpoch` is the current non-exited epoch that owns the Run.
3. `taskId`, `runId` and `sessionId` exactly match the persisted Run and healthy binding.
4. The Run is non-terminal and the event kind is legal in its current Run state.
5. Tool and permission events carry an exact `toolCallId`; permission display/resolution also uses
   the exact `windowId` in the permission identity.
6. The event idempotency key has not committed already. Optional protocol IDs may contribute to the
   key but cannot be its only cross-load identity.

Failure rejects and audits the envelope. It does not retarget it to the active task, latest Run,
current window or newest session.

### Replay admission

A `replay` envelope is accepted only into isolated staging when SessionBinding is
`replay_reconciling`, its load barrier and adapter epoch match, and no live admission is open.
Replay cannot:

- create or transition a Run;
- activate or resolve a permission;
- execute a tool or repeat any side effect;
- advance live thinking/tool timers;
- append directly to the visible/durable timeline.

Reconciliation uses durable local prompt/turn anchors, role, normalized content/tool structure,
ordering and available protocol identifiers. It does not assume message IDs survive load. Exact
duplicates map to existing durable records. New non-conflicting historical records may be staged;
ambiguous or conflicting records block commit and are quarantined for diagnostics. Only an explicit
load-completion barrier plus a complete reconciliation verdict can atomically commit staged history
and return SessionBinding to `healthy`. Missing barrier, epoch loss, malformed replay, timeout or
unresolved conflict discards/quarantines staging, retains local history and marks the binding `broken`.

Live frames arriving before the replay barrier commits are rejected, not buffered into the timeline.
After commit, a later user send creates a new Run and opens live admission under its own identity.

## 8. Required transition tests

Before the first production implementation commit, contract fixtures must cover every legal row and
representative illegal pair, including:

- queued and starting cancellation, including queued `user_cancel -> cancelled` with local
  not-dispatched proof as cancellation evidence, cancel notification without proof, forced
  cancellation, and a normal completion that wins a cancellation race;
- permission allow, deny, expiry, wrong window, duplicate resolution and process orphaning;
- completing transaction failure, process death, EOF, malformed frames, silence timeout and quit;
- renderer loss and suspend/resume while running and while awaiting permission;
- session resume, load replay, missing barrier, duplicate history, unstable message IDs and broken binding;
- stale process events after a new epoch, cross-task/session injection and replay labeled as live;
- terminal-state absorbing properties for every terminal Run state.

The mapping and planned evidence IDs are maintained in `requirements/requirements.yml`.
