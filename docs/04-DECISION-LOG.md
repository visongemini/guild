# Guild 2 decision log

## Accepted

### D-001 — Use a new repository, not a normal branch

Reason: a new repository provides a blank provenance chain and prevents accidental source
inheritance. Guild 1.1 remains preserved independently.

### D-002 — Target version is 2.0.0

Reason: the source, persistence, runtime transport, and module architecture all change. This
is not compatible with an incremental 1.1 patch number.

### D-003 — Keep the official Grok process as the only upstream caller

Reason: preserves the single-user client boundary and official authentication/permission path.

Amended by D-057 and D-058 (2026-10-12): this holds unchanged for the Grok engine. For the Claude
engine the upstream caller is the user-installed `claude` binary driven by the user-installed ACP
adapter; in routed sessions its requests pass through Guild's loopback model router, which forwards
them (D-058). The single-user boundary and the ban on shared or externally reachable gateways are
unchanged.

### D-004 — Separate authoritative state from UI state

Reason: task/session/run ownership and terminal transitions must survive renderer loss, sleep,
and restart without relying on a browser storage blob.

### D-005 — Migration uses a neutral interchange format

Reason: Guild 2 must not depend on or inspect the earlier application's private storage schema.

### D-006 — Preserve the Guild 1.1.13 UI without redesign

Reason: the current UI is an accepted BDV product asset refined through extensive use. Guild 2
changes implementation and architecture, not the visible product. Parity is established through
black-box captures, geometry, and interaction contracts rather than copied renderer source.

Exact parity is subject to the recorded design-lineage inventory. A region that cannot be
cleared for parity receives a named, minimal BDV-approved exception; it is never changed
silently. This does not reopen the general layout or visual direction.

### D-007 — Electron + TypeScript for Guild 2.0.0

Reason: OS-level process inspection confirms that installed Guild 1.1.13 uses Chromium
renderer helpers. The existing visual contract is therefore most realistically reproduced
with the same rendering engine. Electron also supports a single typed language across main,
preload, renderer, and tests. This is a compatibility and schedule decision, not a claim that
TypeScript is newer or intrinsically faster than Rust, Swift, Go, C++, or Java.

Conditions: renderer sandbox and context isolation stay enabled; main owns Grok, SQLite,
power events, and liveness; Electron receives a defined security-update cadence; real lid-close
passes in Phase 1. A Rust/native helper requires a failed measured gate and a narrow scope.

### D-008 — One official Grok process per active task

Reason: both tested topologies completed concurrent prompts, but a shared process interleaved a
late update from an earlier session. Per-active-task processes narrow cancellation, permission,
crash, and liveness failure domains and showed no concurrent authentication lock failure.

The normative decision, controls, and revisit conditions are in
`docs/12-RUNTIME-TOPOLOGY-ADR.md`.

Amended by D-057 (2026-10-12): the rule is now one engine process per active task, whichever engine
the task is bound to (the official Grok process or the Claude adapter process). The topology itself
is unchanged.

### D-009 — Accept official Grok ACP as the primary first-slice transport

Reason: the installed official runtime passed advertised authentication, new session, two live
turns, permission allow/deny, cancel terminalization, process respawn, resume, load/replay, and
post-restore prompts. `session/resume` is primary. `session/load` is a guarded replay path.

This decision does not accept ACP as an account usage, queue, persistence, sleep, or media-prompt
surface. Real lid close and fault injection remain Phase 1 release gates.

### D-010 — Use `node:sqlite` behind a narrow main-only persistence package

Reason: Guild needs SQLite transactions, WAL, STRICT tables, integrity checks, and online
backup, but does not need an ORM or a replaceable driver abstraction. The built-in module
avoids a second native add-on, Electron ABI rebuilds, ASAR native-module handling, and a
separate binary supply chain. Only `packages/persistence` may import `node:sqlite`; it exports
typed domain commands and results rather than database handles, SQL, snapshots, or generic
transactions. A canonical-path sidecar SQLite connection holds one OS-backed exclusive lock, and
the authoritative connection holds a second lock on the real database inode while performing every
application read and write. The pair prevents a one-component path replacement or inode alias from
silently creating a second Guild writer. A private owner record supplies crash evidence without
relying on reusable PIDs. The lease exclusively owns both connections, closes the authoritative
database before the path guard, and forbids raw filesystem opens or copies while live. Guild owns a
private local data directory; coordinated live relocation or replacement of the whole storage
generation is unsupported and must be performed only after the store is quiescent. Stale-owner
recovery is independent unclean-shutdown evidence, and Run terminalization atomically settles both
unresolved permissions and any response outbox still in flight.

This is an implementation decision, not final driver acceptance. `node:sqlite` is still a
Node release-candidate API. Release remains blocked until the pinned Electron/Node runtime
passes packaged-main import, WAL/FULL durability, backup validation, forced-kill recovery,
corruption handling, macOS arm64/x64, and Windows x64 tests. The wrapper remains small so the
driver can be changed if those gates fail.

### D-011 — Official Grok Build is the only model runtime

Reason: Guild is a desktop client for the official Grok Build process, not a general model
router. Third-party adapters made thought parsing, usage payloads, permissions, tool behavior,
and recovery less reliable while bypassing the product's strongest integration path. Guild 2
therefore has no MiniMax, Ornith, OpenAI-compatible provider route, or selector containing
external models. Its bounded selector exposes only verified official Grok models and real
reasoning efforts supported by the runtime.
Thought, tool, permission, session, usage, and model facts come only from official Grok ACP or
other documented official Grok surfaces.

Amended by D-057 and D-058 (2026-10-12): "only model runtime" now holds per engine. The Grok engine
still exposes only official Grok models. A task bound to the Claude engine can use Claude models
through the user's own subscription and, through the loopback model router, Online and Local models
the user configured. The ban on OpenAI-compatible provider routes stands: the router forwards the
Anthropic Messages protocol only and performs no OpenAI-protocol translation.

### D-012 — Local Guild profile is not a Grok account

Reason: nickname and avatar are Guild-local identity for the single-user desktop client. Mixing
them with official Grok login, usage, or credential files would blur the runtime boundary and
invite the client to read `~/.grok/auth.json` or browser/Keychain state. The account panel may
show both surfaces, but they stay labeled separately. Avatars enter only through a main-process
file dialog, magic-byte validation, and the `guild-media://` grant protocol.

### D-013 — Window chrome stays in the layout box

Reason: AS-004 requires the status row, profile/settings bar, and composer to remain visible
when the window is resized. Overlaying the composer and letting the sidebar project list grow
unconstrained pushed those surfaces outside the overflow-hidden pane. They now occupy reserved
grid and flex tracks so the conversation and project list shrink first. This is a layout-contract
fix, not a visual redesign.

### D-014 — Context menus reclamp on viewport resize

Reason: AS-004 and PC-UI-003 require popovers to stay inside the window. The task/workspace
menu stored pixel coordinates from the open event and did not re-render on `resize`, so a
wide-window open followed by a narrow resize left the menu past the right and bottom edges.
The same clamp now runs from a viewport listener. This is not a visual redesign.

### D-015 — Composer send is claimed before React re-renders

Reason: a second `requestSubmit` in the same turn read stale `pendingSends` and issued two
official prompts for one user action. The in-flight claim is synchronous per task, so
double-click or double-Enter cannot start a second send. Queued follow-ups still go through
`sendMessage` after the first turn is accepted. This is not a visual redesign.

### D-016 — UI operations claim a lock before React marks busy

Reason: three last-mode New Task clicks in one turn each passed the async `busy` flag and created
three empty tasks. `run()` now claims a synchronous in-flight lock so overlapping archive,
settings, and create calls no-op until the first settles. This is not a visual redesign.

### D-017 — Vanished workspace folders fail before spawn

Reason: PC-TASK-001 and AS-006 require a truthful recovery path. A workspace under `/tmp` or any
later-deleted folder currently dies in official-process preflight, and the composer collapses that
into “Grok runtime temporarily unavailable.” Send now checks the canonical folder first, refuses
without pinning or spawning `grok`, and names the missing folder. Recreating the folder keeps the
same task retryable.

### D-018 — Overlong composer text is named before IPC

Reason: AS-006 requires a truthful recovery path. Pasting past the 200_000-character IPC bound
made `setDraft` throw `invalid_draft`; the debounce catch then overwrote send classification with
generic “操作未完成.” The composer now refuses that payload in the renderer, does not persist it,
and names the length failure. Shortening the text clears that named error without a send.
Switching or creating a task no longer calls `setDraft` for that oversized payload, so
navigation is not blocked by the same IPC rejection.

### D-019 — Full access is an explicit local official-process mode

Reason: the single-user owner needs a practical mode for trusted workspaces where official Grok
tools do not pause for every approval. Guild therefore persists exactly two values: the safe
default `default` and the user-selected `bypassPermissions`. Both are passed as literal argv to the
official Grok stdio process only while no task is running or queued. This does not read Grok
credentials, create an API route, approve another user, or weaken Guild's closed IPC surface.

### D-020 — Context usage admits exact official prompt metadata without estimating a window

Reason: installed Grok 1.0.5 advertises ACP `usage_update` but emitted none in direct and installed
task tests. Its official `session/prompt` response does emit an exact, increasing
`_meta.totalTokens` value. Guild allowlists only that non-negative integer as current context
occupancy. If a standard `usage_update` later supplies `used` and `size`, the footer also shows the
percentage; otherwise it shows the exact used Token count and does not hardcode a model window.

### D-021 — Slash commands come from the active official Grok session

Reason: the ACP codec already admitted `available_commands_update`, but the desktop service
discarded it before projection, leaving the composer unable to offer commands. Guild now starts or
resumes the official process only after the user explicitly types `/`, projects the session-owned
command list and optional input hints, and sends the selected slash text through the same bounded
prompt path. It does not parse private auth state or swallow unknown slash text. D-023 adds a
versioned cold-start snapshot without changing the active session's execution authority.

### D-022 — Slash-command feedback is a generic Run projection, not a hardcoded command catalogue

Reason: official commands such as `/goal` and `/context` may successfully update hidden session
state without emitting authored assistant text. Guild derives one compact acknowledgement from the
persisted slash user entry, the authoritative Run state, and any real thought/tool activity that
follows. This covers current and future official commands without inventing per-command lifecycle
semantics. Terminal acknowledgement disappears when an authored response
already makes completion clear.

### D-023 — Slash discovery is instant locally and silently refreshed by ACP

Reason: blocking the first `/` menu on process startup made a local desktop control feel like a
network lookup. Guild bundles only the Grok 1.0.13 core-command snapshot, localized and versioned
with the app, so the menu opens synchronously even when Grok is cold or unavailable. It starts the
official session discovery in the background and replaces the snapshot with the exact
`available_commands_update` catalogue when it arrives. User-installed skill commands remain
session-owned and are never copied into Guild. A stale bundled command can still be sent only
through the official Grok process, which remains the execution authority.

### D-024 — Account usage stays attached to the lower-left profile control

Reason: the profile and official-usage summary is a lightweight contextual surface, not a
blocking workflow. Centering it under a modal backdrop detached it from the avatar that opened
it and made a routine glance feel like a settings interruption. The account panel is therefore
a non-modal popover anchored above the lower-left profile bar, bounded by the live sidebar width
and window height, and dismissed by Escape or an outside click. Detailed settings and profile
editing remain independent dialogs because they contain persistent controls or unsaved changes.

### D-025 — System resume never activates the Guild window

Reason: lifecycle recovery belongs to the runtime and renderer state machines, not to macOS window
activation. Calling restore, show, focus, or open-window from `powerMonitor.resume` interrupted the
application the user was actually working in. Resume now refreshes an already existing renderer
and runs the normal lifecycle recovery without changing visibility, minimization, z-order, or
keyboard focus. Main also appends owner-only `os_suspend` and `os_resume` records before lifecycle
recovery so a physical lid-close incident can be distinguished from an ordinary transport loss
without retaining prompts or authored output. Dock/Finder activation may bring Guild forward; a
duplicate process launch does not.

### D-026 — Background task notifications inform without activating Guild

Reason: a long-running local task needs a completion, failure, interruption, or permission signal
when Guild is behind another application, but background work does not grant permission to change
the user's active window. The main process therefore derives notifications from authoritative task
state transitions, suppresses historical and duplicate terminal states, and emits nothing while
Guild is already focused. Notification delivery never calls `show`, `restore`, or `focus`; only an
explicit click opens the exact task and activates Guild. The policy is persisted and can be disabled.

### D-027 — Sidebar task icons are compact projections of authoritative state

Reason: one generic spinner could not distinguish useful work from a queue, permission wait, failure,
or recoverable interruption. The task row now keeps one fixed icon slot and maps the persisted/live
projection to a small set of accessible visual states. Only active work animates. Queued, permission,
failure, interruption, cancellation, and idle states use static symbols and localized labels so the
sidebar remains quiet while still answering whether intervention is required.

### D-028 — Background projection delivery cannot depend on animation frames

Reason: an installed real-task check showed that the main process and database could contain the
completed Run and exact context usage while a background renderer still displayed a spinner and
stale context. Electron may throttle `requestAnimationFrame` when the window is behind another app,
so using an animation frame as the only projection-delivery gate made correctness depend on window
visibility. Projection bursts are now coalesced with one microtask and applied through the existing
React transition. This preserves low-noise rendering without waiting for a foreground paint cycle.

### D-029 — Official Grok administrative capabilities use a typed feature center

Reason: hiding runtime, plugin, MCP, session, memory, worktree, update, setup, trace and diagnostic
functions behind slash text made a desktop client needlessly opaque, but accepting arbitrary CLI text
would turn the renderer into a shell launcher and expose transport surfaces that violate the client-only
boundary. Guild therefore maps every verified user-operable Grok Build 1.0.13 operation to one closed
action and exact parameter schema. The feature center invokes those actions directly, while official
ACP slash commands remain task/session operations. Destructive actions require a separate confirmation;
raw argv, server/relay, headless, debug and rendering flags have no renderer route. Administrative
commands never overlap ACP work or queued turns: Guild closes any retained idle ACP process, owns one
management process group, requires a selected task workspace instead of using application data as a
cwd fallback, and aborts and joins it on shutdown before accepting another task.
Long-running operations publish redacted stdout/stderr incrementally, so device authorization can
show its URL and code while the official Grok process is still polling. Publishing is throttled and
incomplete JSON is withheld until structural redaction is possible.

### D-030 — Local releases use one persistent certificate-backed macOS identity

Reason: the previous fixed Bundle ID was still ad-hoc signed, whose implicit designated requirement
contained the build's `cdhash`. macOS therefore could not recognize the next package as the same code
when checking privacy or App Management grants. Guild now generates one machine-local code-signing
identity in a dedicated user keychain, reuses it for later packages, and verifies that the designated
requirement is identifier-plus-certificate rather than hash-bound. The first move from ad-hoc signing
can require one final grant. This local identity improves update continuity but does not claim public
Developer ID signing or notarization. Before every package, the build unlocks that same keychain,
refreshes its bounded six-hour lock timer, and reapplies the `apple-tool` signing partition so a
background build never falls back to an interactive password prompt or rotates the identity. The
machine-local self-signed certificate explicitly uses `timestamp: none`; a public Developer ID build
must instead use Apple's trusted timestamp and notarization path.

### D-031 — A duplicate executable launch is not foreground intent

Reason: a tool, recovery path, or operating-system launch service can start a second Guild process
without the user clicking Guild. Treating every `second-instance` event as permission to restore,
show and focus the existing window caused background tasks to interrupt unrelated foreground work.
The duplicate instance now exits without changing window visibility or focus; if the renderer window
is absent it is recreated hidden. Dock/Finder activation and notification clicks remain explicit
user actions and retain their foreground behavior.

### D-032 — Renderer recovery reloads the existing native window without activation

Reason: Electron can report a renderer as temporarily `unresponsive` during a resize or a heavy
streaming update even though the process has not crashed. Replacing the BrowserWindow after a short
stall created a new native window and raised it above the application the user was working in.
Guild now ignores short stalls and reloads only after a 15-second continuous unresponsive interval
or an actual renderer-process exit. Recovery keeps the same BrowserWindow and therefore preserves
visibility, bounds, z-order, and focus without choosing between focus theft and a disappearing
window. Background recovery contains no `showInactive`, `show`, `restore`, or `focus` path.
After the recovery limit, an error is deferred while Guild is backgrounded and appears only after
Guild is already focused or explicitly activated by the user.

### D-033 — Runtime recovery restores identity but never replays work

Reason: a process exit during a long `/goal` task previously collapsed to one generic connection
message, while the useful exit code, signal and stderr byte accounting disappeared with the debug console.
Guild now records a bounded private structured incident, terminalizes the exact Run, and exposes its
recovery state plus log location in the diagnostics center. It may resume the same official Grok
session in the background, but it never revives the terminal Run or automatically resends the prompt:
an interrupted tool sequence may already have changed files, Git state or an external service.

### D-034 — Multiplexed Grok workers are observable but not root authors

Reason: official `/goal` work can multiplex worker or reviewer session updates over the root ACP
connection. Dropping all of them made a healthy task appear frozen; appending them to the conversation
would misattribute private worker reasoning as the root answer. Guild therefore orders each child
session independently and projects only its phase, count and tool kinds. Child-authored text is not
persisted into the root timeline, and unbound child permission requests are safely cancelled.

### D-035 — Task files and review occupy a true third column

Reason: presenting task files, diffs and terminal entry as an absolute-positioned drawer covered the
conversation and made the desktop shell behave like a temporary dialog. The task workbench is now a
sibling of the conversation pane in the root grid. Opening it reflows the conversation, keeps all
three columns visible, aligns its header with the conversation top bar, scrolls its contents
independently, and exposes a keyboard/pointer resize separator whose local width survives relaunch.
Closing it returns the exact width to the conversation without leaving an invisible overlay.

### D-036 — User-message actions must not change bubble height

Reason: the transparent copy, branch and retry action row still participated in normal layout, so
every user message appeared to contain an extra blank line. The actions now sit immediately to the
left of the bubble as an anchored child. Pointer hover and keyboard focus still reveal them, while
the bubble height is determined only by its authored content and intentional padding.

### D-037 — Sidebar recency is user intent, not runtime noise

Reason: using every persisted runtime event as task activity made concurrent task rows reorder while
Grok was thinking, streaming text or running tools. That creates a moving click target and destroys
the user's spatial memory. Task recency now advances only when the user starts or queues a turn;
manual pinning may establish pinned order. Background output and drafts update their own state without
touching the sidebar ordering clock.

### D-038 — Queue preemption cancels before dispatch

Reason: `Move next` did not satisfy the user's intended meaning of 插队: the selected message must
take over from work that is still running. Guild keeps FIFO by default, but `Interrupt & run`
durably promotes the selected queued turn and records cancellation intent for the exact current Run
before sending the official Grok cancel request. The selected turn is dispatched only after that
Run reaches a terminal state, so root prompts never overlap and a stale renderer cannot cancel the
wrong Run.

### D-039 — Session restoration is not a successful Run result

Reason: a restored Grok session only proves that later messages can use the same session identity;
it does not complete or resume the interrupted instruction. Rendering that restoration as ordinary
timeline copy beside a checked `Latest result` card made an interrupted Run look successful and made
missing evidence look like proof that no files changed. Guild now presents a distinct warning card,
keeps the Run visibly interrupted, labels an evidence-free outcome as unconfirmed, and offers explicit
edit-and-retry and local-diagnostics actions. Retry still returns text to the composer instead of
silently replaying work that may already have produced side effects.
An idle transport recovery remains visible in diagnostics only; it must not create a timeline card
claiming that an instruction was interrupted when no nonterminal Run existed.

### D-040 — A replacement session receives task-local context exactly once

Reason: official `session/resume` can fail even though Guild still has a correct local transcript.
Starting an empty replacement session under the same task and then forwarding a short message such
as `continue` forced Grok to guess prior work; global memory could point that guess at a sibling
project. Guild now builds a bounded recovery capsule only from the exact task's title, canonical
workspace, earlier user-authored instructions and observed task tool paths that resolve inside the
workspace after symlinks are resolved. The recovery requirement is written before replacement
creation begins, closing the crash window between official `session/new` commitment and local
model/mode configuration. The capsule is attached only to the first replacement prompt and is marked
established only after official prompt acceptance; acceptance, replay proof, and handoff consumption
commit atomically. The proof covers the complete ordered text/resource envelope, and resource-bearing
history fails closed when ACP load cannot prove those resources. An oversized first message cannot consume it. It
is never rendered as user-authored text, never imports another task, and never automatically replays
the interrupted instruction. When no task-local definition exists, ambiguous continuation is refused
before Run creation and the user must state the intended work explicitly.

### D-041 — Loaded history must prove content and authored order, not merely resemble it

Reason: matching only visible text, final tool snapshots, media MIME type, or globally deduplicated
assistant/thought labels can attach the wrong official history to a task. Guild now requires a v2
outbound prompt proof, adjacent authored-order segments, exact bidirectional tool/plan evidence, and
SHA-256 of decoded media bytes. Older turns without the proof, turns containing unprovable prompt
resources, unsupported replay content, or any ordering/content conflict require explicit replacement.

### D-042 — Safe replay proof may reject lossy or boundary-ambiguous official history

Reason: ACP tool updates may contain private raw input/output or non-text blocks that Guild intentionally
does not persist, and optional message IDs cannot prove whether consecutive user notifications are chunks
or separate turns. Guild records only a boolean that tool proof became unavailable, never the discarded
secret. Such turns and user boundaries fail closed. Plans use a canonical SHA-256 over ordered entries
while the UI stores only a bounded preview. Optional interrupted turns use subsequence reconciliation,
but completed turns and consumed replacement capsules are mandatory. A prompt write followed by local
acceptance failure is classified as delivery-unconfirmed, never safe-to-resend.
Tool IDs use one domain-separated canonical-JSON SHA-256 namespace everywhere; this avoids both
raw/synthetic key aliasing and JavaScript UTF-8 replacement collisions between unpaired surrogates.

### D-043 — Oversized tool display output is lossy, not session-fatal

Reason: the official Grok runtime can place a large command result or diff in one legal
`tool_call_update`. Guild previously applied its persistence string ceiling while decoding that
display field, classified the resulting `string_limit_exceeded` as a protocol fault, and terminated
the whole ACP session. Tool titles and output are now retained as bounded, Unicode-safe previews and
marked `replayProofUnavailable`; subsequent replay reconciliation therefore still fails closed.
Session IDs, tool-call IDs, callback IDs, canonical paths, enums, and malformed structures remain
strict and session-fatal. A restored incident projects one recovery card in place of its transient
transport-error paragraph, while the complete incident remains available in private diagnostics.

### D-044 — Guild continuous tasks own continuation instead of nesting official `/goal`

Reason: official `/goal` may validly decide that a broad request is complete after one bounded
turn, while blindly resending the same objective risks duplicate edits and cannot prove progress.
Guild therefore offers a separate durable controller with an immutable objective and alternating
work/audit Runs sent through ordinary official ACP prompts. Exact Run correlation prevents normal
messages from advancing the controller; queued user turns win scheduling priority. Completion
requires an explicit audit verdict with no remaining gaps. Cancellation, transport loss, restart,
runtime unavailability, and malformed audit output stop automatic continuation and require visible
user action. This keeps `/goal` semantics intact and prevents two continuation controllers from
fighting over the same session.

### D-045 — Preserve draft ownership, rehydrate history, and separate continuous-task display

Implements PC-DATA-001, PC-CONV-001 and PC-CONV-002 in response to the 2026-09-11 audit.
An unsent nonempty draft or persisted continuous objective prevents temporary-task cleanup.
Automatic first-message naming is separate from discard eligibility, so a saved draft does not
suppress the title and failed runtime startup cannot erase a durable objective. Bootstrap and explicit task opening
rehydrate all pages previously requested, including after renderer cache eviction; ordinary
streaming projections remain bounded to the latest page. Exhausted history requests also retain
the full requested window. Activity grouping appends to a private builder and freezes once,
preserving order and public immutability without repeated whole-array copies.

Continuous-task objective, summary, remaining work and actions remain visible in a compact
bilingual status card with expandable details. Only a complete recognized terminal control footer
outside a code fence is rendered as expandable round notes. The original assistant text remains
unchanged for persistence, copying, export and controller decisions; screen-reader completion
announcements use the same presentation body; a model assessment is not
relabeled as authoritative task completion. Official Grok transport and permission semantics are
unchanged. Fixture executable startup has its own 15-second test budget, while stop/reap test and
production deadlines are unchanged. The js-yaml build dependency advances to its patched 4.3.2.

The process-test ownership teardown uses a temporary non-privileged, locally signed copy of system `ps` on macOS because sandbox-exec refuses the system setuid executable. It retains PID/PGID plus fixture-path ownership checks before cleanup signals, and removes the tool after testing. This is test-only; packaged runtime policy is unchanged.

## Open questions

- Which renderer library gives the smallest maintainable implementation and best streaming
  behavior without obscuring measured 1.1.13 geometry?
- Which official Grok CLI operation, if any, exposes usage and reset data without reading
  private authentication storage?
- What BDV-owned source assets exist for the icon and Banny animation?
- Which 1.1 capabilities are genuine 2.0 requirements rather than inherited scope?
- Which open-source license will BDV choose for the independently written implementation?


## D-046 — Full Guild 2.1 frontend redesign

Date: 2026-09-12. The user requested “直接全部重做” after the complete seven-area
frontend review. This is explicit authorization to replace prior visual parity with
a new complete frontend and to select a design without pausing for another choice.
The first displayed Quiet Workshop concept is the visual target; the original mascot
and admitted Phosphor icon library retain their identities. Source separation remains.

Implement navigation, conversation/result lifecycle, message-level search, workbench
empty states, tools/settings information architecture, reading controls, draft-only
starters and unambiguous workspace management as one coherent release. Backup/restore
validation is a separate data gate. Do not silently replace runtime semantics or infer
verified test results from prose. Freeze the pre-change worktree and keep independent
review, unit/integration, packaged UI and installed real-runtime gates.

## D-047 — Single-line composer with native content sizing

Date: 2026-09-12. The user requested that the bottom input reserve one line by
default and grow only as text increases. Keep the existing rows=1 and CSS
field-sizing: content, bounded maximum height, and overflow scrolling. Reduce
the redesign's 65px minimum textarea height and vertical padding to one text row.
The outer focus-within ring remains; suppress the duplicate textarea outline.
No sending, queue, persistence, runtime, or continuous-task behavior changes.

## D-048 — Optical alignment of the Guild wordmark; Banny only in the empty-task centre

Date: 2026-09-12. Amended: 2026-10-12.

The user supplied a cropped brand screenshot and requested proper mascot/text
alignment. The admitted 314x314 Banny PNG has nontransparent bounds
(102,95)-(269,308): its vertical content center is 44.5 source pixels below the
image center, so aligning the bitmap box looked low beside the lettering.

Amendment (2026-10-12). Guild is a complete product and Banny is only a mascot,
so it now appears in exactly one place: centered above the starter title of an
empty task, 76x92 CSS pixels (56x68 in windows up to 760px wide), with its gentle
idle bob, which reduced motion switches off. The sidebar header is the Guild title
and the engine-version line only, aligned with the search icon and section label,
so there is no header image to align. The floating window placement, the
task-row seat and drag-and-drop moving are removed; Banny is not draggable.
Placements saved by earlier builds are ignored and their storage keys are
dropped once at startup. The Welcome screen shown with no task open keeps its
Code icon. The original alignment note (28px image, 4px lift, flex gap 9px to
7px) no longer describes the code, which had a 22px header image and an 8px gap
before the image was removed, and is withdrawn with the image.

## D-049 — Bound streaming admission and decouple display cadence

Date: 2026-09-13. The user reports a few tokens per second during continuous
tasks and authorizes the measured performance fix. Implements PC-EVENT-001,
PC-TRN-002 and PC-CONV-001. A synthetic 100k-event task spent about 294 ms
per text commit scanning and canonicalizing every historic admission key.

Use the existing (task_id, idempotency_key) primary key to supply only the
matching record to event admission. Preserve cross-Run/cross-epoch collision
detection, receive-sequence checks, prompt correlation and atomic mutations;
full-store integrity verification remains intact. No schema change.

After durable text/thought commits, schedule one shared display publication
without waiting for its 16 ms cadence on each chunk. Yield to the event loop
after at most an 8 ms processing slice so buffered streams do not starve UI
publication, cancellation or transport events. Non-text, permission and
terminal barriers continue awaiting publication. Observe each background
publication failure once in content-free runtime diagnostics; storage and
admission failures still reject the update. Shutdown drains the scheduled
publication before closing storage. Preserve continuous work/audit semantics,
model settings and the official Grok process boundary.

Verify old-key deduplication and collisions after restart, stale/gapped
sequences, atomic terminal commits, partial burst display and exact terminal
text, event-loop yielding, cancellation, replay, restart and installed-session
continuation. Compare the same synthetic long-history benchmark before/after;
fragment throughput is never labeled as upstream model token throughput.

## D-050 — Adopt official semantic titles once and keep settings selectors theme-safe

Date: 2026-09-15. The user requested Codex-style automatic task naming with as few
words as practical, and reported invisible model choices in dark mode. A first
instruction receives a local fallback capped at 16 CJK/mixed code points or six
English words. When the official Grok session emits `session_info_update.title`,
Guild accepts one bounded semantic title only if the current title still exactly
matches that fallback. A manual rename therefore remains authoritative. No extra
model request or private inference route is added.

Settings selectors and their options use the existing theme surface/text tokens
and inherit the document color scheme. This preserves the Quiet Workshop palette
while preventing a light native control surface from pairing with dark-theme text.

## D-051 — Materialize tool images behind the existing private media boundary

The visible tool timeline now admits image blocks that official Grok ACP returns as tool content.
Main verifies canonical base64, the 8 MiB ceiling, MIME, magic bytes, dimensions, and Electron image
decoding before replacing the body with a random `guild-media://` grant. Completed tools may also
offer an image preview from an ACP location, but only after the resolved no-follow regular file is
proven to be inside the active workspace. The renderer never receives the original base64 or local
path. The first tool action expands a small in-flow preview; only clicking that preview opens the
full-screen viewer shared with inline Markdown images. The viewer retains Escape, backdrop, and
close-button behavior. Tool audio, embedded resources, and resource links remain placeholders.

Reason: users need to see the same visual evidence the agent actually inspected without widening
the renderer filesystem capability or treating raw tool input/output as trusted presentation data.

## D-052 — Cold-start work is paid once: cached binary identity, one shared pinned copy, kept idle processes, prewarm

Reason: diagnostics from 107 real starts showed a median 5.3 s from "start" to a usable session, while
the raw official binary reaches `session/new` in about 0.25 s. Every spawn located the binary with
`which`, hashed all 168 MB, ran `grok --version`, copied the binary into a new private directory,
fsynced it and hashed it again; macOS additionally inspects a never-executed file on its first
launch (about 2 s for this binary). The pinning intent (the executed bytes equal the pinned SHA-256,
independent of the source pathname) is unchanged; the work is now done once per binary instead of
once per process:

- The located binary (path, SHA-256, version) is cached for the life of the app and trusted only
  while the PATH hit still resolves to the same file and its device, inode, size, mtime and ctime are
  unchanged. A repointed symlink, an in-place update, a failed preflight or a failed spawn re-locates.
- The staged copy is shared, content-addressed (`.grok-pin-<sha256>`), and published by an atomic
  rename after the existing first-stage checks (regular file, Mach-O, independent inode, read-only,
  hash equals the pin). It is reused only while its identity (device, inode, size, mtime, ctime, mode
  0500, owner, link count) and its private directory are unchanged; a missing or altered copy is
  replaced. A copy left by an earlier process is adopted only after it hashes to the pin. A process
  never deletes the shared copy; leftovers of other SHA-256 values and orphaned private stages older
  than an hour are removed at app start. `pinExecutable` keeps its private per-process semantics for
  the deterministic teardown tests.
- System resume no longer closes every runtime. A process that served a Run, or was still starting,
  is closed exactly as before (its Run is terminalized and a prompt that may still be in flight in it
  must not overlap the next one; prompts are never replayed). An idle healthy process only has to answer
  one local stdio round trip (an unknown extension method, which the official runtime rejects with
  "method not found" in under a millisecond; no session and no upstream traffic). Architecture states
  that an alive process with dead stdio is not healthy, so a process that does not answer within 2 s is
  closed and restarts lazily from the durable binding. Probing cannot prove upstream connections are
  still usable; a hung prompt after wake is still handled by cancel escalation.
- The active task's process is prewarmed (spawn, initialize, authenticate, `session/resume`) when the
  task is restored, selected, typed into, or after resume, without ever sending a prompt. A prewarm
  and a send share the same in-flight start. Only tasks whose binding awaits restore are prewarmed:
  creating a session for a task the user may discard would leave an empty official session behind.
  A prewarmed process that was never used is released when another task becomes active, a failed
  prewarm is not retried for 15 s, and it is not shown as task activity.
- Official usage borrows an already authenticated live process instead of starting an extra one, and
  falls back to a dedicated process only if the borrowed call fails.
- The child environment carries fixed Guild-owned values that keep OpenViking memory out of Guild
  sessions entirely (amended 2026-10-10, owner: OpenViking is for Claude Code and Codex only):
  `OPENVIKING_MEMORY_ENABLED=0`, both config file paths set to `/dev/null`, and the MCP URL set to a
  closed local port. This replaced the earlier `OPENVIKING_RECALL_COMPRESS=off`.

Amended by D-057 and D-060 (2026-10-12): the fixed OpenViking kill-switch block above applies to the
Grok engine only. For the Claude engine OpenViking is on (no kill-switch variables); in routed Claude
sessions automatic capture is off and recall stays.

## D-053 — Stream text as deltas and publish full projections only on structural change

Date: 2026-10-09. Implements WP4 of `docs/18-SPEED-PLAN-2.2.md` and amends D-049. During a long
answer main rebuilt and re-sent the whole bootstrap (about 1 MB, several MB on large tasks) up to
60 times per second, and the renderer re-rendered every row for each one.

Authored text and thought chunks now also produce a small `StreamDeltaEvent` on the registered
`guild:v1:event:stream-delta` channel (active task only, coalesced to one per 16 ms per entry,
validated against a closed schema right before send). The delta is never an authority: it carries
the UTF-16 offset it appends at, the renderer shows `projection text + delta suffix`, ignores
duplicates, rejects other tasks, and every full projection supersedes the suffix. Full projections
are rebuilt on structural change (new entry, tool/plan/permission/run-state change, sidebar or
settings change) and at most every 250 ms (longer if the last build was slow) while text streams.
This replaces D-049's per-chunk publication; its yielding, partial-display, ordering and
terminal-text guarantees are unchanged, and terminal and permission barriers still await
publication. Tool, plan and sub-agent updates now schedule publication instead of holding the
one-at-a-time update queue, and `sendMessage` hands the prompt to the official process before it
publishes the new Run.

Main reuses rows it already decoded and integrity-verified while a read-only stamp query
(`entry_id`, `sequence`, `revision`) shows them unchanged. The renderer applies projections once
per frame with a timer fallback for hidden windows, shares unchanged objects between projections,
memoizes rows, re-parses only the last Markdown block of a streaming message, mounts collapsed
activity and tool-output bodies on demand, and uses observers instead of post-commit layout reads.
Finished rows away from the live tail use `content-visibility: auto` with estimated placeholder
heights. A finished message is still rendered as one document, so final markup is unchanged.

## D-054 — The model list belongs to the runtime; the phase indicator reads only allowlisted `_x.ai` signals

Date: 2026-10-09. Implements WP5 of `docs/18-SPEED-PLAN-2.2.md` and F1a/F1b of
`docs/19-BORROWED-FEATURES-FEASIBILITY.md`. D-011 is unchanged: only xAI `grok-*` models are
selectable. The installed runtime also advertises models the owner added to the CLI's own config
(for example MiniMax and a local endpoint); Guild drops them when it decodes the list.

- No model or effort is hard-coded. The catalog comes from `initialize` `_meta.modelState`,
  `session/new` and `session/resume` `models`, and `_x.ai/models/update`, is cached in
  `runtime_model_catalog` (schema v16) so the picker has choices before a process starts, and ids
  are validated as bounded identifiers (`grok-` + `[A-Za-z0-9._:-]`, 64 characters), not an enum.
- The process is started without `--model` / `--reasoning-effort`. Model, effort and context window
  are applied per session: `_meta.reasoningEffort` on `session/new` and resume, then
  `session/set_config_option` (model first, effort second; the effort choices belong to the model)
  after the session opens and before each prompt, never mid-turn. `session/set_model` remains only
  for the context window. A runtime refusal (-32602, `MODEL_SWITCH_INCOMPATIBLE_AGENT`) keeps the
  previous selection and is reported as `incompatible_agent`, `unsupported_value` or `unavailable`.
  Changing model or effort never closes an adapter; permission mode and startup flags still do.
- Selection resolves task override (`task_runtime_settings`), then global default, then the
  runtime's own default. `''` in `app_settings` means "follow the runtime default" and is what a new
  install gets. Schema v16 rewrote exactly the old pair (`grok-4.6` + `xhigh`) to `grok-4.7` +
  `high` once, with the owner's approval of 2026-10-09; no other value was touched. When nothing is
  pinned Guild does not touch the model of a resumed session.
- `_x.ai/*` notifications are parsed through one allowlist (`packages/runtime-grok/src/xai-extensions.ts`)
  into bounded signals: enum-like identifiers and counts only. Prompt text, hook names and output,
  tool arguments, usage, signatures, retry reason text and `_x.ai/mcp/servers_updated` (MCP settings
  with secrets in plain text) are never decoded, stored or logged. The phase of the running turn is
  derived by a pure tracker (`packages/domain/src/run-phase.ts`) from Guild-authoritative state
  (Run state, streamed content, tool and permission state) plus those signals, carried in the
  existing projection as ephemeral display state, and shown with one 1 Hz renderer tick.
- Extension requests use `AcpV1Adapter.sendExtensionRequest`: names must match
  `^_x.ai/[a-z]...`, -32601 means "unsupported" and is remembered per process, any other error is
  `AcpV1ExtensionRequestError`. Steer (`_x.ai/interject`) and rewind (`_x.ai/rewind/*`) build on it.

Amended by D-057 and D-058 (2026-10-12): "the model list belongs to the runtime" holds per engine.
The Grok engine's list is unchanged, including dropping owner-configured third-party entries. The
Claude engine's list is what the adapter reports in native sessions; Online and Local entries come
from the model sources the user configured and confirmed, not from either runtime. The cached
catalog is keyed by engine.

## D-055 — Steer injects into the running turn through the official process; checkpoints and rewind are Guild's own git state plus the official conversation rewind

Date: 2026-10-10. Implements F4 and F2 of `docs/19-BORROWED-FEATURES-FEASIBILITY.md` (backend and IPC
only; schema v17). Verified against the real `grok` 1.0.50 through Guild's own service path in a
throwaway git repository (four tiny model turns in total, see the end of this entry).

Steer (`steerMessage`, `convertQueuedTurnToSteer`)
- The text is trimmed (the runtime trims queued text), the intent is stored first (`task_interjections`,
  state `sending`), then `_x.ai/interject {sessionId, text, interjectionId}` goes to the official
  process. Only when the runtime answers `queued` does Guild create the `user` entry (metadata
  `interjection`, `interjectionId`) and move the row to `pending`. The runtime's
  `_x.ai/session/interjection` echo moves it to `delivered`; only the client-made id is read from the
  echo (the allowlist keeps no text). An echo that beats the response is remembered, an acknowledged
  request whose echo never comes counts as delivered when the Run ends. A normal send during a Run
  still queues in Guild's durable queue.
- Fallback: `-32601` (remembered per process, so the extension is not asked again), a turn that is not
  running or steerable, or a rejected request all become an ordinary send (queue while a Run is
  active, new Run otherwise) with the reason returned to the caller and, when a turn was involved,
  recorded as a `fallen_back` row plus a localized `notice` entry. No user entry is created for a
  Steer the runtime did not take, so the message is never shown twice.
- The runtime runs a Steer that missed its turn as its own prompt (`interject-fallback-*`) with no
  JSON-RPC response. The adapter treats a turn frame with no Guild prompt in flight as an
  agent-started turn: it waits for the previous prompt's terminal commit, attaches the turn through
  the new optional sink hook `commitAgentTurnStarted` (the Run, the user message taken from
  `_x.ai/queue/changed` `runningText`, and the outbound-prompt replay proof), streams its frames with
  the allocated prompt sequence and ends it from `turn_completed` (a fallback turn emits no
  `prompt_complete`). When Guild cannot give it a Run (one of Guild's own is in flight) the sink
  declines, the frames are dropped, its permission requests are cancelled and the transport stays
  healthy. A sink without the hook keeps the old protocol fault. If the turn's text equals a Steer
  Guild sent, the turn's own user entry is a hidden replay anchor and the Steer is shown once.
- Replay: the runtime persists a mid-turn Steer as a `user_message_chunk` with `_meta.interjection:
  true`. The codec flags it and the reconciler skips it (it never opens a turn); local Steer entries
  are not turns either. Rolled-back Runs are left out of the local history because the runtime drops
  a rewound branch from its replay.

Checkpoints and changed files
- `apps/desktop/src/main/git-checkpoints.ts`: a capture builds a tree in a private `GIT_INDEX_FILE`
  (a copy of the real index dated to the epoch so a same-size edit inside one second is still
  re-read), `commit-tree` with a fixed author, `update-ref refs/guild/checkpoints/<task>/<n>`
  (`2k-1` at Run `k` start, `2k` at its end). The user's index, HEAD, branches, stash and reflogs are
  never written; hooks, fsmonitor, gc and signing are off; every process has a deadline; untracked file
  count and size are guarded; a non-git folder, missing git, timeout or guard is `unavailable` with a
  reason and never an error.
- The start capture runs after the Run exists and before `session/prompt`; the prompt waits for it
  up to 3.5 s, after which the late capture is discarded and the Run's checkpoint is `unavailable`
  (`timeout`). Captures of one task run strictly in order (end of Run k, start of Run k+1). The end
  capture starts after the Run is terminal and stores `git diff --numstat -z -M` plus name-status
  (200 files kept, totals kept for all) in `run_checkpoints`. A turn the runtime started itself is
  captured when Guild first sees it, so edits made before its first frame can be absorbed into its
  start state.

Rewind (`previewRewind`, `executeRewind`)
- Only while the task is idle. The official prompt index of a Run is the number of earlier
  non-rolled-back accepted Runs of the same session; Guild requires `_x.ai/rewind/points` to list
  exactly that many prompts, to be numbered `0..n-1`, and the target's preview to match the Run's
  first line, then runs the official dry run (`conversation_only`, or `all` outside git). Any mismatch
  refuses with `prompt_index_mismatch`.
- File plan: the paths each undone Run changed (its own start to end checkpoints), restored from the
  first Run's start checkpoint (exists there) or deleted (the Runs added them); anything else, including
  edits the user made between Runs, is left alone. A path that differs from the first Run's end
  checkpoint is a conflict: `later_run` (expected) or `modified_after_run` (needs
  `overwriteConflicts`). `git restore --source=<ref> --worktree` never touches the index, so a staged
  change survives.
- Execute order: official `conversation_only` with `force:true` first (a refusal changes nothing),
  then the file restore, then the Runs are marked `rolled_back` (rows kept, entries dimmed through
  `rolledBack`), the prompt text goes into the draft and a notice entry is added. If the runtime has no
  `_x.ai/rewind/*`, the conversation is not rewound and `scope: "files_only"` is offered, explicitly
  labeled, without marking any Run rolled back.
- The preview states what cannot be undone: network and MCP effects, git commits and pushes made by
  commands, memory writes, and (without a git checkpoint) shell file changes.

Residual risks: `git push --mirror` would publish `refs/guild/*`; checkpoint refs are not pruned; a Steer
that races a queued turn's dispatch can reach the runtime twice; a Guild send racing a runtime-started
turn fails the new Run with the usual "send again" notice.

Amendment (2026-10-10): the prompt no longer waits up to 3.5 s for the start checkpoint. It
waits at most 400 ms (typical repositories capture in 0.1-0.3 s; a 2,900-file repository measured
~240 ms), then goes out while a slower capture continues. A `tool_call_create` that arrives before
the capture settles marks that Run's start checkpoint unavailable, so a capture that might contain
the agent's first edit is never offered for rewind.

## D-056 — A task can work in its own git worktree; Guild runs the git, and merges only through a read-only check and `git merge --no-ff`

Date: 2026-10-10. Implements F3 of `docs/19-BORROWED-FEATURES-FEASIBILITY.md` (backend, IPC, UI; schema v18).
The official `_x.ai/git/worktree/apply` failed both live tests and there is no merge command, so Guild
uses its own local git, with the bounded hook-free runner of D-055 (`git-checkpoints.ts` `runGit`).

Creation (`createTask({ workspaceId, isolation: "worktree" })`)
- The workspace folder must be inside a git work tree (`rev-parse --show-toplevel`) with at least one
  commit. Otherwise the call throws `worktree_<reason>` (`not_a_git_repo`, `no_commits`,
  `workspace_not_in_commit`, `git_unavailable`, `timeout`, `git_failed`); that fixed code is the only
  message `toDesktopIpcFailure` lets through besides the three older ones, and no task row is left behind.
- `git worktree add -b guild/<slug>-<hash8> <data>/worktrees/<taskId> <HEAD commit>`. The slug is the
  ASCII title (placeholder titles give `task`), the hash comes from the task id. `base_commit` and
  `base_branch` (absent on a detached HEAD) are recorded. A workspace that is a sub-folder of the
  repository maps to the same sub-folder of the worktree (`source_repo_path` is the top level).
- The new worktree has committed files only: no ignored files (node_modules) and none of the owner's
  uncommitted changes. The UI says so in the chip menu.

Where the task works
- `taskRootPath` (live service) replaces the workspace folder everywhere a task is scoped: the process
  working directory and `session/new|resume|load` cwd, prompt attachments, tool-media, files the
  workbench opens, recovery capsules, and the F2 checkpoints and rewind. `assertUsable` refuses a
  discarded worktree and one whose real path is not under `<data>/worktrees`, whatever the stored row says.
- Verified live with grok 1.0.50: one tiny turn in a worktree task inside a scratch repository answered
  with the worktree path as its working directory; the scratch repository stayed clean.

Status (`task_worktrees`): dirty files, commits ahead and behind come from one bounded `git status` and
`git rev-list --left-right --count` (5 s), refreshed when a task is opened (at most once a second), after
every Run and after Apply, never per chunk. `unavailable` keeps the last numbers.

Apply (`previewWorktreeApply`, `applyWorktree`)
- Refused while a Run, a queued turn or a send is in flight. Apply holds the command queue for its whole
  duration, so no Run can start in between; the preview does not.
- Preview is read-only: uncommitted files become a snapshot commit object built in a private index
  (never a commit on the branch), then `git merge-tree --write-tree` against the base branch tip names
  conflicting files (git 2.38+, else `git_too_old`). It is refused when the checkout is not on the base
  branch (the branch it is on is named), a merge, rebase, cherry-pick, revert or bisect is in progress,
  the checkout has staged changes (git refuses any non-fast-forward merge with them), or has
  uncommitted changes in a file the merge changes.
- Apply re-runs the same evaluation, then commits uncommitted files in the worktree as `Guild
  <guild@localhost>` ("Guild task changes: <title>"), then `git merge --no-ff --no-edit --no-verify
  --no-gpg-sign`, with the owner's own identity when git has one. A merge that conflicts anyway (the
  checkout changed after the check) is aborted with `git merge --abort` and HEAD is verified to be where
  it was; the repository is never left mid-merge. The result is verified to be a two-parent commit on the
  old tip. After a merge the status is `applied`; the worktree and branch stay, and new work makes the
  status `active` again.
- Never pushes, fetches, rebases, resets, stashes or checks out in the owner's checkout.

Discard: confirmation in the UI (it lists the uncommitted files and unmerged commits that go). Then
`git worktree remove --force <path>` (only a directory directly under `<data>/worktrees`, real path
checked) and `git branch -D <recorded guild/ branch>` (only that name shape); a worktree directory the
owner deleted by hand is cleaned with the same command and no `worktree prune`, so the owner's other
worktrees are never touched. The row becomes `discarded`; the task stays readable and cannot send.
A missing folder is status `missing` (send disabled with a banner; only discard is offered). Starting
another task while the open one is untouched removes its fresh worktree; one that holds work is kept
and titled with its branch so it shows in the sidebar.

Interface: the new-task option (checkbox on a task with no message, only for git workspaces, remembered
per workspace in local storage), topbar chip with branch, "领先 n" and "有 m 处未提交", chip menu (merge,
discard, Finder, Terminal, note on ignored files), sidebar branch glyph for an idle worktree task,
task-menu entries, merge and discard dialogs, composer banner. All strings are in `worktree-messages.ts`.

Residual risks: deleting a task does not remove its worktree (its branch and files stay for the owner to
find with `git branch`); `refs/guild/checkpoints/<task>/*` of a discarded task stay; a worktree path
longer than the OS limit fails creation (reported as `git_failed`); git hooks of the owner's repository
are deliberately not run, so a repository that depends on a post-checkout hook (for example to install
dependencies) gets none; large repositories make creation take seconds (60 s budget).

## D-057 — Two engines, Grok and Claude Code; the engine is fixed per task at its first turn

Date: 2026-10-12. Owner decision (single user, owner of this repository). Implements PC-ENG-001,
PC-ENG-002, PC-MODEL-001 and PC-SET-002; amends D-003, D-008, D-011 and D-054. The implementation
brief is `docs/20-GUILD3-DUAL-ENGINE.md`; its protocol facts were measured on this machine on
2026-10-12 with `@agentclientprotocol/claude-agent-acp` 0.89.1 and `claude` 2.1.291.

Context: Guild 2 was a client for the official Grok process only (D-003, D-011). The owner wants one
window with a second engine, Claude Code as the owner already has it installed and logged in. The
Grok path stays as it is.

Decision
- Engines. `grok` is the official `grok agent stdio` process, unchanged. `claude` is the
  user-installed ACP adapter `@agentclientprotocol/claude-agent-acp` (a Node script) driving the
  user-installed `claude` binary through the Agent SDK. Guild distributes neither; it locates, pins
  and checks them.
- Binding. `task_metadata.engine` (`grok` | `claude`, default `grok`) is set when the task's first
  turn is created and never changes (PC-TASK-001: no silent rebinding). A new task's model picker
  shows the Grok group next to the Claude groups; the group chosen for the first turn fixes the
  engine. While Claude Code lists no model yet (a first run) the Claude group offers "Claude Code
  (default model)", which moves the task to Claude and follows Claude Code's own default, unless
  Claude Code is not found. Inside a Claude task the picker switches between turns among Claude
  (subscription), Online and Local models (D-058).
- Topology. One engine process per active task, as D-008.
- Claude process. The executable pin is the user's `node` (existing Mach-O pin) plus the adapter
  entry script as `argv[0]`. The adapter is pinned by package version (supported range
  `>=0.89.0 <0.90.0`) and a SHA-256 over its installed `package.json` and `dist/` tree; a mismatch
  refuses to start with a named error. `claude` comes from `~/.local/bin/claude` or PATH, the adapter
  from `~/.npm-global/bin`, PATH and Homebrew paths, and `node` (>= 22) from PATH. The environment is
  an allowlist plus Guild-owned values (`NO_PROXY=127.0.0.1,localhost` always,
  `CLAUDE_CODE_EXECUTABLE=<pinned claude>`); every inherited `ANTHROPIC_*` and `CLAUDE_CODE_*`
  variable is stripped first. There is no `--rules` argv. Permission mode is set with
  `session/set_config_option` after the session starts, not by argv or restart.
- Credentials. Guild never reads Claude credentials: it does not read the Keychain or any `claude`
  file for them and never calls `authenticate`. The `claude` binary uses its own login. If the adapter
  advertises auth methods and the first session fails with auth required, Guild shows the named
  reduced state "Run `claude` once in Terminal and log in".
- Reduced capability (PC-FALLBACK-001). Steer injects through `_session/steering` and queues only on
  `promptRequired`; rewind falls back to files only (the existing -32601 fallback). The usage panel shows context usage from `usage_update` and the quota
  as "Managed by Claude Code". The Grok control center and the Grok slash snapshot belong to the Grok
  engine only. The phase line shows generic phases only.
- Independence. Guild states that it is independent from xAI and from Anthropic.

Consequences
- D-003, D-008, D-011 and D-054 carry amendment notes; their text is not rewritten.
- Settings tabs become General / Engines / Model sources / Privacy / About (PC-SET-002).
- Requirement dispositions: PC-ACC-001 (model clauses), PC-SET-001, PC-SEC-001 (gateway clause) and
  PC-GROK-001 (external-model clause) are superseded in `requirements/requirements.yml` and remain
  present.
- Schema, contract, runtime, orchestration and packaging changes follow in the work packages of
  `docs/20-GUILD3-DUAL-ENGINE.md`; this entry and its siblings D-058 to D-060 are the governing text.

## D-058 — A loopback model router lets Claude tasks use Online and Local models

Date: 2026-10-12. Owner decision. Implements PC-ROUTE-001, PC-ROUTE-002, PC-ROUTE-003, PC-MODEL-001
and PC-PRIV-001; amends D-003 and D-011 and narrows the gateway clause of PC-SEC-001.

Amended by D-061 (2026-10-12): the Anthropic upstream described below (the Anthropic ids of the exact
registry, forwarding of the Authorization header to `api.anthropic.com`, the Anthropic header allowlist
and the Anthropic thinking-signature rule) no longer exists. The router serves Online and Local models only.
D-061 also made a routed task unable to use Claude subscription models; D-062 (2026-10-13) lifted that, and a
task now switches both ways. The text below is kept as decided.

Context: measured facts in `docs/20-GUILD3-DUAL-ENGINE.md` section 2. Claude Code can drive an
Anthropic-compatible backend through `ANTHROPIC_BASE_URL`, but it then sends request shapes that
plain backends reject (messages with `role: "system"`, `tool_addition` blocks, `defer_loading`,
`context_management`, `output_config`; DeepSeek returned 422), it carries thinking blocks signed by
another vendor, and llama.cpp streams content blocks out of order, which made Claude Code duplicate
the reply text.

Decision
- Native and routed sessions. A Claude session starts native: no `ANTHROPIC_BASE_URL`, the model list
  is the adapter's own. The first time the user picks an Online or Local model, Guild, between turns,
  records `task_metadata.routed_at`, restarts that task's adapter with `ANTHROPIC_BASE_URL=<router
  url>`, `ENABLE_TOOL_SEARCH=true` and `OPENVIKING_AUTO_CAPTURE=false`, resumes the same session with
  the enabled Online and Local models in `_meta.claudeCode.options.settings.modelPicker`, then sets
  the model. Once routed, always routed, also after Guild restarts. Switching among models of a routed
  session is a plain `set_config_option`. Guild never uses the adapter's `providers/set` or gateway
  `authenticate`, because they bypass the Claude login.
- Router. It runs in the Electron main process (`packages/model-router`), lives as long as the main
  process and starts lazily on the first routed session. It listens on `127.0.0.1` only, on a random
  port, at `http://127.0.0.1:<port>/<token>/` with a 32-hex random token; a wrong token is 404.
  Binding to any non-loopback address throws at startup. `GET /<token>/v1/models` lists the Online and
  Local models.
- Exact registry. Anthropic ids are the Claude model ids the adapter reported in native sessions plus
  the `claude-*` ids the CLI sends for background work; Online and Local ids are the configured ones.
  An unknown model is a 404 JSON error, never a default upstream. Redirects are never followed.
- Credential rules. OAuth/Authorization is forwarded only to the fixed host `api.anthropic.com` over
  https, with an allowlist of request headers. Requests to Online and Local sources drop
  `authorization`, `x-api-key` and `anthropic-beta`, then carry the source key. Third-party keys come
  from a user-designated env file (path and variable name per source), are read in main when the
  router starts or a source is confirmed, live in memory only, and never reach SQLite, IPC payloads,
  the renderer or logs. Logs carry model, source id, status and booleans, never credential or header
  values.
- Host binding. Adding a source or changing its base URL or key variable requires a native
  confirmation dialog in main that names the variable and the host (for an Online source it also says
  that Claude task conversations go to that host; a keyless source exists for Local only, and an
  Online source without a key variable is refused). A key is sent only to the host it
  was confirmed for; a renderer request alone cannot activate a change. Online sources are https only.
  Local sources are http or https, and resolved IPs must be loopback or in 100.64.0.0/10 (Tailscale),
  checked before connecting.
- Compat layer (Online and Local only; Anthropic gets the original body). It removes `role: "system"`
  messages and re-inserts their text as one `<system-reminder>` block after the next user message's
  `tool_result` blocks, moves `tool_addition` definitions into `tools`, drops `defer_loading` tools
  and non-standard tool fields, removes top-level `context_management` and `output_config`, merges
  consecutive same-role messages with `tool_result` first, and replaces empty content with
  `(empty)`.
- Thinking provenance. The router records `sha256(signature)[:32] -> source id` for every thinking
  signature it sees (persisted through an injected store, a SQLite table in Guild) and drops thinking
  blocks not produced by the target source before forwarding. Unknown provenance is dropped for Online
  and Local; for Anthropic it is kept only if the signature is a long base64 string.
- Local SSE normalizer. Local streams are re-sequenced so a block's events are emitted before any
  event of a higher index.
- No OpenAI translation. Every supported backend speaks Anthropic Messages natively; the router does
  not translate protocols.
- Online-model reminder (PC-PRIV-001). The first time a conversation switches to an Online model of a
  vendor (a model source) Guild asks for confirmation, stating that CLAUDE.md, memory, the
  conversation and browser page text or screenshots in the conversation will be sent to that vendor.
  The agreement is remembered per conversation and per vendor, so Online A, then Claude, then Online B
  asks again for B. The option "Don't remind me again in this workspace" persists per workspace and
  silences every reminder. Local and Claude models never remind.

Consequences
- The gateway clause of PC-SEC-001 is narrowed, not dropped: a shared or externally reachable gateway
  stays prohibited; a loopback-only, token-guarded, single-user router is allowed under PC-ROUTE-001.
- Residual risks. In routed sessions the router sees the conversation and the Authorization header of
  `claude`'s own requests in transit; the header goes only to `api.anthropic.com` and is never logged
  or stored. Content sent to an Online vendor leaves the machine after the reminder; content sent to
  a Local source stays on the machine or tailnet. A local model can be slow (a trivial turn on the 27B
  model took 48 s because of prefill) and that is not a defect.
- The tests required by `docs/20-GUILD3-DUAL-ENGINE.md` section 3.4 (non-loopback bind, bad token,
  credential forwarding, unknown model, no secrets in logs) are acceptance gates, not follow-ups.

## D-059 — An isolated browser pane, an agent browser tool server, and a split Electron security profile

Date: 2026-10-12. Owner decision. Implements PC-BROWSER-001 and PC-BROWSER-002; amends the
no-remote-content statement of `docs/09-ELECTRON-SECURITY-PROFILE.md` and the browser non-goal of
`docs/01-PRODUCT-CONTRACT.md`. PC-SEC-002 is unchanged.

Decision
- Browser pane. A `WebContentsView` in the workbench column as a new tab "Browser" next to Files and
  Review, in session partition `persist:guild-browser`, with `sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`, no preload and `backgroundThrottling: false`.
  Navigation is limited to `http:`, `https:` and `about:blank`. `window.open` opens a new pane tab (at
  most 5) or is denied. Every permission request is denied (camera, microphone, geolocation,
  notifications, clipboard read and the rest). Downloads require a native save dialog. No external
  login state is copied. The UI has an address bar, back, forward and reload, tabs, an "agent is
  operating" badge with "Take over", which pauses agent control (tools answer "paused by user") until
  "Resume agent".
- Security profile split. Guild's own renderer keeps every existing guard unchanged. Only web contents
  created by the browser module in partition `persist:guild-browser` receive the navigation allowance.
  The guard functions key on the registry of web contents ids, not on URL heuristics. The debugger is
  attached only to pane contents, and only after the first page load.
- Browser MCP server. Minimal MCP over Streamable HTTP with JSON responses, in main, with no new
  dependency, at `127.0.0.1:<random>/<token>/mcp`. Methods: `initialize`,
  `notifications/initialized`, `ping`, `tools/list`, `tools/call`; anything else is -32601. Tools:
  `navigate`, `back`, `forward`, `reload`, `screenshot` (CDP `Page.captureScreenshot`), `read_page`
  (CDP accessibility tree), `get_text`, `find`, `click`, `type`, `key`, `scroll`, `console_messages`,
  `network_requests`, `tabs_list`, `tab_select`. There is no `eval` tool.
- Wiring. The server is passed to engines in `mcpServers` of `session/new` and `session/resume` as an
  HTTP server named `guild-browser`: always for Claude, and for Grok only if its `initialize`
  advertises `mcpCapabilities.http`. Every tool call follows the engine's permission mode: it appears
  as a permission card unless the mode or an "always allow" choice already permits it.

Consequences
- `docs/09-ELECTRON-SECURITY-PROFILE.md` documents the split; docs/01 drops "general-purpose browser"
  from the non-goals.
- Page text and screenshots an agent reads become conversation content. With an Online model that
  content goes to the vendor, which is covered by the reminder of D-058.
- The token in a loopback URL (router or browser MCP) may be handed only to the engine process of
  the task that uses it, through its environment or `mcpServers` entry. It never enters renderer
  payloads, logs, crash data or fixtures (amendment to the secrets section of docs/09).

## D-060 — OpenViking per engine and routed state

Date: 2026-10-12. Owner decision. Implements PC-OV-001. Supersedes the 2026-10-10 amendment of D-052
for the Claude engine only.

Context: the D-052 amendment keeps OpenViking out of Guild sessions because the owner uses it for
Claude Code and Codex only. The Claude engine runs Claude Code itself, and recall was measured to work
inside ACP sessions; the OpenViking plugin (0.4.4) honors `OPENVIKING_AUTO_CAPTURE=false`, which
disables capture and the write hooks while keeping recall.

Decision
- Claude engine: OpenViking on. The Guild-owned kill-switch environment block is not injected.
- Routed Claude sessions (D-058): `OPENVIKING_AUTO_CAPTURE=false`. Recall stays; capture and write
  hooks are off.
- Grok engine: unchanged. The D-052 kill-switch block (`OPENVIKING_MEMORY_ENABLED=0`, both config
  paths set to `/dev/null`, MCP URL set to a closed local port) still applies.

Consequences
- A Claude task that has become routed keeps capture off for the rest of its life, because routed is
  permanent per task.
- Content that reaches an Online vendor is still governed by the reminder of D-058, and OpenViking
  recall output is part of what that reminder names (memory).

## D-061 — Subscription credentials never traverse the model router; the Claude-to-routed switch is one-way

Date: 2026-10-12. Owner decision. Implements PC-ROUTE-001, PC-ROUTE-002 and PC-MODEL-001; amends D-058
(credential rules, exact registry, thinking provenance, native and routed sessions) and D-057 (the model
group choice inside a Claude task).

Amended by D-062 (2026-10-13): the "One way" clause below, its picker lock, the `claude_locked` refusal and
the one-way confirmation are superseded; the switch between a Claude model and an Online or Local model is
two-way. Everything else in this entry stands: the throwaway token, the router without an Anthropic upstream
and the credential rejection are unchanged. The text below is kept as decided.

Context: Anthropic's legal and compliance terms for Claude Code
(`code.claude.com/docs/en/legal-and-compliance`) and its Acceptable Use Policy (effective 2026-11-12)
forbid intermediating Claude subscription (OAuth) credentials and proxying requests through consumer
subscriptions. In a routed task of Guild 3.0.0, Claude Code (with only `ANTHROPIC_BASE_URL` set) sent
its subscription bearer token to the router, which forwarded `claude-*` requests carrying that token to
`api.anthropic.com`. Verified on this machine on 2026-10-12 with Claude Code 2.1.296 in a clean
environment: with `ANTHROPIC_BASE_URL` alone it sends `Authorization: Bearer sk-ant-oat...` (the
subscription token) to the base URL; with `ANTHROPIC_AUTH_TOKEN` also set it sends only that value and the
subscription token never leaves Claude Code.

Decision
- Throwaway token. Every start of a routed process gets `ANTHROPIC_AUTH_TOKEN=guild-router-<32 random hex
  characters>`, new for each launch, never logged and redacted from diagnostics, and never an
  `ANTHROPIC_API_KEY`. It also gets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and the routed model
  applied at that start as `ANTHROPIC_SMALL_FAST_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` (never the
  `ANTHROPIC_DEFAULT_*_MODEL` variables: any of them makes the adapter drop that id from the modelPicker), so Claude
  Code's background requests (titles, summaries, compaction) and its subagents stay on the third-party
  source instead of asking for `claude-*` models. Native Claude sessions keep their environment unchanged
  (no base URL, no throwaway token).
- Router. It has no Anthropic upstream: it never opens a connection to `api.anthropic.com`. A request is
  served only if its model is a registered, enabled and confirmed Online or Local model; any other model
  gets an Anthropic-style JSON error (a `claude-*` model: 400, "Claude subscription models are not
  available in a task that uses online or local models"; another unknown model: 404). As defense in depth,
  a request whose `Authorization` or `x-api-key` value (after an optional `Bearer `) starts with `sk-ant-`
  is rejected with 400 before anything is forwarded, with a fixed console warning that carries no value.
  Client credentials and `anthropic-beta` are still never sent to a third party; Online and Local sources
  receive only their own key. The Anthropic registry and `noteAnthropicModels` plumbing, the Anthropic
  header allowlist branch and the Anthropic-specific thinking-signature rule are removed; a thinking block
  is kept only for the source that produced it.
- One way (superseded by D-062). A task that is routed (`task_metadata.routed_at` set, or its process is routed) can no longer
  use a Claude subscription model. The picker shows the Claude rows disabled under one line, the main
  process refuses the selection with the reason `claude_locked`, a Claude choice stored by an earlier build
  (or the Claude global default) no longer counts for such a task, and a turn that would start on a
  non-routed model ends with `model_selection_failed` before anything is sent. A Claude task that has
  already run turns on a native session confirms before its first switch to an Online or Local model; when
  an Online reminder is also due, one dialog carries both messages. A new task with no turn yet picks
  freely, because routing is decided at its first run. Tasks already marked routed follow these rules from
  their next start (throwaway token, Claude rows disabled).
- A user who wants Claude after a routed switch starts a new task.

Consequences
- The remaining routed traffic is Claude Code talking to Guild's router with a token that proves nothing,
  and the router talking to the user's own Online and Local sources. No Claude credential is read,
  forwarded, logged or stored by Guild.
- Residual: the model variables are fixed when the process starts. A switch between routed models of a
  live session is a plain config option, so Claude Code's background requests and subagents stay on the
  source of the last (re)start until the next one; the Online reminder still covers each vendor the
  conversation itself goes to.
- Thinking-provenance rows that name `anthropic` stay in SQLite and prove nothing for any source; the id
  `anthropic` stays reserved so no source can inherit them.
- A routed process sends no Claude Code telemetry or update traffic.
- Requirement text of PC-ROUTE-001, PC-ROUTE-002, PC-ROUTE-003 and PC-MODEL-001 and the acceptance story
  AS-011 are updated in `requirements/requirements.yml`; `docs/20-GUILD3-DUAL-ENGINE.md` sections 2, 3.3,
  3.4, 3.7 and 6 follow this entry.

## D-062 — Switching between a Claude model and an Online or Local model is two-way; the subscription still never traverses the router

Date: 2026-10-13. Owner decision. Implements PC-ROUTE-002, PC-MODEL-001, PC-PRIV-001 and PC-OV-001; supersedes
the "One way" clause of D-061 and the "native until the first Online or Local selection, then routed for good"
rule of D-058 and `docs/20-GUILD3-DUAL-ENGINE.md` 3.3.

Context: D-061 made the switch from Claude to Online or Local one-way so the Claude subscription token could
never pass through Guild's router. The lock was a means, not the goal. Verified on this machine with Claude Code
2.1.296 in a clean environment: a session can go native Claude, then routed DeepSeek, then
native Claude again. `claude -p --resume <id>` run natively (no `ANTHROPIC_BASE_URL`, the subscription login,
straight to `api.anthropic.com`) continues a session whose history contains DeepSeek turns, including a DeepSeek
thinking block, with both Haiku and Opus 5.5. So the way back does not need the router at all.

Decision
- Two-way. A Claude task can switch between a Claude subscription model and an Online or Local model in either
  direction, between turns, in the same conversation. The mode of the engine process at every start (the switch,
  a crash recovery, a Guild restart) follows the task's selected model: an Online or Local model starts a routed
  process (the 3.0.1 routed environment, unchanged), a Claude model or the Claude default starts a native process
  with none of the routed variables. There is no lock any more: no disabled Claude rows, no `claude_locked`
  refusal, no main-process refusal of a Claude model for a routed task, no one-way notice in the switch dialog.
- Switching back restarts natively. Between turns Guild closes the routed process, starts the native one with the
  same start options minus the routed `modelPicker` (the browser MCP server stays), `session/resume`s the same
  session, and then applies the model. This mirrors the native to routed switch, one serialized start operation
  that concurrent callers join: prompts, queued turns and continuous rounds wait for it (`sessionStartPending`)
  and never go out on the wrong backend. On failure the selection rolls back to what was running and the error
  is surfaced like other selection failures; a resume timeout keeps the session and only the agent's own
  no-such-session answer (-32002) replaces it. The Claude subscription login therefore goes only from the native
  `claude` process to Anthropic and never to the router; a routed process still carries only the throwaway token.
- Between models of the same mode nothing restarts: Claude to Claude, and Online to Local or Online to Online
  (the routed small-fast and subagent model variables may keep naming the model of the last start until the next
  one, as recorded in D-061).
- A native process resumed after routed turns reads the model of its last turn from the transcript, an Online or
  Local id that Claude does not offer. Guild applies the selected Claude model, or the Claude default when the
  choice was cleared, before the first turn.
- `task_metadata.routed_at_ms` stays, with a new meaning: the task has used an Online or Local model at least
  once. It is written once, after a routed process took the selection, and never cleared. It no longer forces any
  process mode. There is no schema migration (schema v19).
- OpenViking. Capture stays off (`OPENVIKING_AUTO_CAPTURE=false`) for every process of a task that has the marker,
  native ones included, so third-party output never enters the memory store; recall stays on. A task that never
  used a routed model keeps D-060 as it was.
- Privacy. The per-vendor Online reminder is unchanged (first switch to each online vendor per task, "do not
  remind me again in this workspace"). Switching back to Claude and switching to a Local model never ask.
- Switch UX. Crossing the boundary can take 30 to 120 seconds. In a Claude task that has run turns, the picker
  tags the rows whose choice crosses it ("Restarts"), the picker trigger shows a spinner and "Switching..." and
  the composer shows one status line above the hints while the switch runs; a failure shows the existing
  selection-failure message. A new task with no turn, a Grok task and same-mode rows show none of this.
- The router keeps every D-061 guard: it never connects to Anthropic, refuses `claude-*` models, rejects
  `sk-ant-` credentials and refuses Anthropic hosts as sources.

Consequences
- A user no longer starts a new task to get Claude back after trying an Online or Local model.
- The cost of a cross-mode switch is a process restart and a resume, paid once per crossing.
- A task that goes native after routed turns still has OpenViking capture off for good. A task that never routed
  is unaffected.
- Requirement text of PC-MODEL-001, PC-ROUTE-002, PC-OV-001 and PC-PRIV-001 and the acceptance story AS-011 are
  updated in `requirements/requirements.yml`; `docs/20-GUILD3-DUAL-ENGINE.md` sections 1, 3.3, 3.6, 3.7 and 6
  follow this entry.

## D-063 — Guild 3.0.2 UI polish: which model answered, a connection test, a Stop button that stops

Date: 2026-10-13. Owner request ("make the UI more refined"). Implements PC-CONV-001, PC-MODEL-001, PC-SET-002,
PC-ROUTE-002, PC-PERM-002, PC-A11Y-001 and PC-UI-003. No visual redesign: the warm-paper light theme, the dark
theme, the icons and the accent colour are unchanged.

Decisions
- **Per-turn model attribution.** Schema v20 adds `run_model_labels` (one row per Run: the display name of the
  model the Run started on, written after the engine applied the task's selection and before the prompt goes out).
  Additive, forward-only: Guild 3.0.1 cannot open a database written by 3.0.2 (`schema_version_unsupported`),
  like every earlier migration. The other way round works: a local backup made by 3.0.0 or 3.0.1 (schema 19) is
  still accepted for restore (`local-backup.ts` takes schema 19 up to the current one) and migrates forward when
  the restored database opens; a backup newer than the build, or older than 3.0, is refused as before. The name is
  the catalog's (the model's own label for an Online or Local model; for the Claude Default row the model the
  adapter says it stands for, and no row when it says nothing). The task view carries the labels of the Runs in
  its window; the footer of a finished turn shows "model - time" on one muted line. A Run from before the table
  has no label and shows only the time.
- **Connection test.** `guild:v1:model-sources:test`, see `docs/20-GUILD3-DUAL-ENGINE.md` 3.4. The probe lives in
  `packages/model-router` and reuses the router's own source rules (extracted to `source-policy.ts`), headers and
  transport, so a test can never reach a host or carry a key a real turn could not.
- **The permission card's last button stops the turn.** It used to answer the pending request with ACP's
  `cancelled` outcome while the turn was running. Checked on 2026-10-13 against both engines: under Grok that
  closed the transport (`sink_fault`, the Run ended `interrupted` and the session was recovered); under Claude it
  only aborted that tool call and the turn went on with another approach. It is now labeled "Stop this turn" and
  calls `cancelRun`, the composer's stop path, which answers a pending request with `cancelled` while the Run is
  cancelling and ends the turn as cancelled on both engines. The standard options are labeled by their ACP kind
  in Chinese (allow once, allow for this session, reject, reject always) with the agent's text as the tooltip; an
  "always" option is labeled "for this session" only when the agent's own text says session.
- **One hero.** The welcome screen and the empty task render the same `GuildHero` (mascot, G-U-I-L-D, helper line),
  so the mascot is placed in exactly one place (PC-UI-003).
- **Result strip.** The "latest result" strip is not drawn for a completed run whose changed-files card is on
  screen; it stays for every other case.

Consequences
- `requirements/requirements.yml` is unchanged: the statements already cover these behaviours; the commits cite
  the requirement IDs.
