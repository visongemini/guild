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

## D-048 — Optical alignment of the Guild wordmark

Date: 2026-09-12. The user supplied a cropped brand screenshot and requested
proper mascot/text alignment. The admitted 314x314 Banny PNG has nontransparent
bounds (102,95)-(269,308): its vertical content center is 44.5 source pixels
below the image center. At the existing 28px image width that is 3.97 CSS pixels.
Keep the original asset and scale; move only the brand image up 4px and tighten
the flex gap from 9px to 7px. Task mascots and empty-state mascots are unchanged.

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
