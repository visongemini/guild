# `@guild/runtime-grok`

Transport and ACP v1 runtime primitives for the owned official Grok subprocess. This package
contains strict NDJSON framing, a strict JSON-RPC 2.0 peer, executable-pinned stdio process
ownership, and a bounded ACP adapter that publishes normalized events through an injected durable
sink. It implements transport-foundation portions of PC-SEC-001, PC-TRN-001, PC-TRN-002,
PC-TRN-003, and ADR D-008. It does not own mutable Run, Permission, SessionBinding, persistence, or
UI state and does not claim any product requirement or Phase 1 complete.

The process host implements the PC-SEC-001 / ADR D-008 owned-process decision. It requires an
absolute executable, working directory, and staging root. Before every spawn it resolves the
executable, opens it with `O_NOFOLLOW`, requires an executable Mach-O regular file, and copies the
already-open descriptor into one random private `0700` directory below the resolved staging root.
The copy is created with exclusive no-follow semantics, synced, made `0500`, reopened with
`O_NOFOLLOW`, verified as a non-writable executable Mach-O, and hash-checked. Bigint identity and
metadata snapshots are rechecked around the copy and hash, and the staged file must be a different
inode from the source. Only that independently copied staged pathname is spawned.

The returned pin object is runtime-frozen. Immediately before `spawn`, the host directly calls its
frozen `verifyForSpawn()` closure, reopens the private stage with `O_NOFOLLOW`, and compares
regular/executable/non-writable status plus `dev`, `ino`, `mode`, `size`, `mtimeNs`, and `ctimeNs`
across the reopened pathname, the retained descriptor, and the verified snapshot. A replacement or
mutation is a truthful `executable_changed` preflight failure and removes only that private stage.

Node on macOS has neither `fexecve` nor pidfds. Consequently the host cannot execute the retained
descriptor itself. The final path check closes the identified replacement/mutation windows covered
by the host, but it cannot absolutely eliminate a same-UID race between that check and Node's
pathname-based `spawn`. A mutation or pathname replacement of the original source inode after the
verified independent copy cannot alter the staged executable. Script/shebang files are rejected;
production execution is Mach-O only.

Children have a resolved fixed cwd and an explicit frozen null-prototype environment. The optional
base environment is snapshotted at host construction and defaults to empty, not to the caller's
`process.env`. Only `PATH`, locale, temporary
directory, proxy (including conventional lowercase proxy names), certificate, and SSH-agent entries
from the documented allowlist may cross the boundary. `HOME` is always forced to `os.homedir()` and
`PATH` is always present (the documented macOS fallback is
`/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`). `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `NODE_PATH`,
`ELECTRON_RUN_AS_NODE`, `BASH_ENV`, `ENV`, and `ZDOTDIR` are removed. Environment values are never
included in diagnostics or receipts. The start receipt records the resolved cwd and the
`macos-posix-v3` policy version. Claude/Cursor compatibility remains available for skills and MCPs,
but their external agent and rules imports are forced off for Guild-owned processes so workspace
personas cannot replace Grok's identity or client contract. The host neither searches for credentials nor reads any
authentication file; the official Grok process remains responsible for its own authentication.
The desktop keeps an explicit inherited proxy when one exists. For a Finder-style launch without
proxy variables, it reads the active macOS system proxy and passes only validated HTTP/HTTPS (or,
when those are absent, SOCKS) endpoints through this same allowlist. Guild never becomes a proxy or
sends the model request itself; the official Grok child still owns every upstream request.

On POSIX/macOS the child starts detached as a process-group leader and the staged pathname plus its
retained descriptor remain alive for the whole owned process-group lifetime. `start()` and `stop()`
are single-flight, including synchronous event-listener re-entry. Explicit stop, and automatic cleanup
after direct-child exit, use the same bounded TERM-then-KILL group reaper. The reaper probes the owned
PGID before TERM and on every lifecycle poll, independently of direct-child `close`; an `ESRCH`
observation is irreversible and prevents all later signals to that PGID. Direct-child `close` alone is
evidence, not termination: successful group completion requires both that close and `ESRCH` for the
owned PGID. The retained stage handle is then closed and only the host's generated private staging
directory is removed. Receipts record actual TERM/KILL outcomes (`sent`, already-gone, or typed
non-ESRCH failure), group absence, and the cleanup result; they do not claim Node reaped grandchildren.

If the combined TERM and KILL grace expires without both direct-child close and confirmed group
absence, the host enters terminal `failed` state. Its cached `stop()` promise and
`waitForTermination()` reject with the same `reap_timeout` error object. The host still closes the
retained stage handle and attempts removal of its private directory; a cleanup failure is separately
reported in the terminal failure event or successful reap receipt and never changes process-group
evidence. On macOS, Node has no pidfd, so this remains an observation-based process-group boundary:
`ESRCH` confirms only that the owned PGID is absent at the probe, not that Node individually reaped
every historical descendant.

Private-stage cleanup has a fixed production deadline that callers cannot configure. If cleanup
misses it, `stop()` and `waitForTermination()` settle with authoritative group evidence and a
truthful `cleanup_pending` / `timed_out` result whose handle and directory state are `unknown`.
Cleanup continues in the background. A completed late result is emitted diagnostically, while
terminal listeners are retained for only a fixed bounded window and never create another lifecycle
wait.

Production always derives an exact frozen argv from closed Guild settings, for example
`--permission-mode default --rules <fixed Guild client rule> agent --no-leader --model grok-4.6 --reasoning-effort xhigh stdio`.
The top-level permission mode precedes `agent`; the agent options precede the `stdio` transport.
`GrokProcessHostOptions` has no argv input, and each production host snapshots the fixed profile, so
callers cannot append or replace arguments. Fixture-only argv belongs to the package-internal test
constructor. The only permission modes are the default interactive mode and the user's explicit
local `bypassPermissions` choice. Production never accepts arbitrary approval vocabulary, a
server/bind mode, or a shared secret.

A successful stdin write receipt proves only local stream completion; it is not evidence that the
remote process accepted or acted on a JSON-RPC message. The owning integration must stop and reap
the affected process epoch.

NDJSON decoding is terminal on the first protocol fault. When one input chunk completes valid
frames before a later frame faults, `NdjsonProtocolError.framesBeforeFault` contains a frozen ordered
array of those valid frames. Consumers must admit those frames in order before handling the
terminal fault; the fault is neither delayed nor swallowed.

The ACP v1 codec is a strict, ACP-SDK-free wire boundary over the repository's normalized
runtime-payload contract. It emits the exact minimal initialize/session/text-prompt parameters,
encodes cancellation parameters, preserves callback ID and optional message-ID types, and strips
`_meta`, raw tool input/output, and unknown extension data. Visible agent/user image and audio chunks,
plus image blocks explicitly returned as tool content, are MIME-allowlisted, canonical-base64 checked,
and size-bounded before the application can persist them behind a private media grant. Thought media,
tool audio, resource links, and embedded resources remain explicit nonfatal placeholders without
retaining their bodies or paths.
Known malformed v1 fields and configured input bounds are typed errors; unknown session-update
discriminators return `ignored_extension`.

`AcpV1Adapter` wires one process epoch through the NDJSON decoder and JSON-RPC peer. Initialize,
authentication, and session operations have finite response deadlines; prompts deliberately have
no response deadline and remain bounded by transport/process proof. The adapter retains the exact
decoded initialize object for explicit authentication, capability-gates resume/load, frames cancel
as an ID-free notification, enforces one active prompt per session, and allows an awaiting permission
callback to coexist with later inbound frames. Session establishment, prompt acceptance, updates,
permission decisions/flush evidence, terminal results, interruption, and load replay barriers cross
an injected sink. A returned session or admitted turn never precedes the corresponding durable sink
commit. Before the first permission-response byte, the sink must atomically return the chosen outcome
plus its already-claimed outbox command ID, version, and delivery-attempt ID; the exact correlation is
echoed only after the callback writer completes. The admitted permission transaction stays ahead of
the prompt terminal commit until that exact flush is durable. A cancellation or terminal proof may
abort only a still-unresolved preparation, which the sink must durably stop through its signal;
no permission response or flush is then claimed. Transport loss aborts the same gate before durable
interruption. Local write receipts remain only local evidence; cancellation alone is not terminal.

This is a transport/runtime vertical slice, not an application adapter. It does not choose an auth or
permission method, mutate domain machines, persist media, render UI, recover an interrupted Run, or
prove end-to-end product behavior.
